// Package porchcrypto exposes the RFC 9580 implementation to Swift using gomobile.
// It contains application binding checks, not cryptographic primitives.
package porchcrypto

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/ProtonMail/go-crypto/openpgp/armor"
	"github.com/ProtonMail/go-crypto/openpgp/packet"
	"github.com/ProtonMail/go-crypto/openpgp/s2k"
	pgp "github.com/ProtonMail/gopenpgp/v3/crypto"
	"github.com/ProtonMail/gopenpgp/v3/profile"
)

const maxPlaintext = 30 * 1024 * 1024
const maxCiphertext = 44 * 1024 * 1024
const protocol = "porchday-openpgp-v1"

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var secretPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func handle() *pgp.PGPHandle {
	p := profile.RFC9580()
	p.MaxDecompressedMessageSize = maxPlaintext
	p.CompressionAlgorithm = packet.CompressionNone
	p.AeadEncryption = &packet.AEADConfig{DefaultMode: packet.AEADModeGCM}
	p.AeadKeyEncryption = &packet.AEADConfig{DefaultMode: packet.AEADModeGCM}
	p.S2kKeyEncryption = &s2k.Config{S2KMode: s2k.IteratedSaltedS2K, S2KCount: 16777216}
	p.S2kEncryption = &s2k.Config{S2KMode: s2k.IteratedSaltedS2K, S2KCount: 16777216}
	return pgp.PGPWithProfile(p)
}

// NewSecret returns a 256-bit member-held secret. Never send this to the API.
func NewSecret() (string, error) {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func checkSecret(s string) error {
	if !secretPattern.MatchString(s) {
		return errors.New("expected generated 256-bit secret")
	}
	return nil
}
func marshal(value any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}
func canonical(data string) ([]byte, error) {
	var v any
	dec := json.NewDecoder(strings.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return marshal(v)
}
func equalJSON(a, b []byte) bool {
	ca, ea := canonical(string(a))
	cb, eb := canonical(string(b))
	return ea == nil && eb == nil && bytes.Equal(ca, cb)
}

// Session owns an unlocked device key in memory. Close on logout/background locking.
type Session struct{ key *pgp.Key }

func NewSession(protectedKey, secret, expectedFingerprint string) (*Session, error) {
	if err := checkSecret(secret); err != nil {
		return nil, err
	}
	locked, err := pgp.NewKeyFromArmored(protectedKey)
	if err != nil {
		return nil, err
	}
	isLocked, err := locked.IsLocked()
	if err != nil || !isLocked {
		return nil, errors.New("private-key backup is not protected")
	}
	key, err := locked.Unlock([]byte(secret))
	if err != nil {
		return nil, err
	}
	valid, err := key.Check()
	if err != nil || !valid {
		key.ClearPrivateParams()
		return nil, errors.New("invalid private key backup")
	}
	if expectedFingerprint != "" && key.GetFingerprint() != expectedFingerprint {
		key.ClearPrivateParams()
		return nil, errors.New("recovered fingerprint mismatch")
	}
	return &Session{key: key}, nil
}

// SessionFromKeychain is only for device-only Keychain data, never API-provided plaintext keys.
func SessionFromKeychain(privateArmor, expectedFingerprint string) (*Session, error) {
	key, err := pgp.NewKeyFromArmored(privateArmor)
	if err != nil {
		return nil, err
	}
	locked, err := key.IsLocked()
	if err != nil || locked || key.GetFingerprint() != expectedFingerprint {
		return nil, errors.New("keychain device mismatch")
	}
	return &Session{key: key}, nil
}
func (s *Session) Close() {
	if s.key != nil {
		s.key.ClearPrivateParams()
		s.key = nil
	}
}
func (s *Session) check() error {
	if s == nil || s.key == nil {
		return errors.New("device is locked")
	}
	return nil
}
func (s *Session) Fingerprint() string {
	if s.key == nil {
		return ""
	}
	return s.key.GetFingerprint()
}
func (s *Session) KeychainArmor() (string, error) {
	if e := s.check(); e != nil {
		return "", e
	}
	return s.key.Armor()
}

// GenerateDeviceKeys returns the same JSON object as the browser library.
func GenerateDeviceKeys(memberID, deviceID, secret string) (string, error) {
	if !idPattern.MatchString(memberID) || !idPattern.MatchString(deviceID) {
		return "", errors.New("invalid member or device ID")
	}
	var err error
	if secret == "" {
		secret, err = NewSecret()
		if err != nil {
			return "", err
		}
	}
	if err = checkSecret(secret); err != nil {
		return "", err
	}
	key, err := handle().KeyGeneration().AddUserId("Porchday "+memberID+"/"+deviceID, "").New().GenerateKey()
	if err != nil {
		return "", err
	}
	defer key.ClearPrivateParams()
	public, err := key.GetArmoredPublicKey()
	if err != nil {
		return "", err
	}
	locked, err := handle().LockKey(key, []byte(secret))
	if err != nil {
		return "", err
	}
	private, err := locked.Armor()
	if err != nil {
		return "", err
	}
	b, err := marshal(map[string]any{"publicKey": public, "encryptedPrivateKey": private, "recoverySecret": secret, "fingerprint": key.GetFingerprint()})
	return string(b), err
}

// PublicFingerprint validates and returns a full RFC9580 fingerprint.
func PublicFingerprint(armor string) (string, error) {
	key, err := pgp.NewKeyFromArmored(armor)
	if err != nil {
		return "", err
	}
	if key.IsPrivate() || len(key.GetFingerprint()) != 64 {
		return "", errors.New("v6 key required")
	}
	return key.GetFingerprint(), nil
}

type context struct {
	ID             string  `json:"id"`
	Kind           string  `json:"kind"`
	AuthorID       string  `json:"authorId"`
	AuthorDeviceID string  `json:"authorDeviceId"`
	Audience       string  `json:"audience"`
	ParentID       *string `json:"parentId"`
	GroupID        *string `json:"groupId"`
	Epoch          int64   `json:"epoch"`
	CreatedAt      string  `json:"createdAt"`
	ExpiresAt      *string `json:"expiresAt"`
	Revision       int64   `json:"revision"`
}
type recipient struct {
	MemberID  string `json:"memberId"`
	DeviceID  string `json:"deviceId"`
	PublicKey string `json:"publicKey"`
}
type reference struct {
	MemberID    string `json:"memberId"`
	DeviceID    string `json:"deviceId"`
	Fingerprint string `json:"fingerprint"`
}
type envelope struct {
	V          int             `json:"v"`
	Protocol   string          `json:"protocol"`
	Context    json.RawMessage `json:"context"`
	Recipients []reference     `json:"recipients"`
	Ciphertext string          `json:"ciphertext"`
}

func validateContext(raw json.RawMessage) (*context, error) {
	var c context
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return nil, err
	}
	if !idPattern.MatchString(c.ID) || !idPattern.MatchString(c.AuthorID) || !idPattern.MatchString(c.AuthorDeviceID) || c.Epoch < 0 || c.Revision < 1 {
		return nil, errors.New("invalid content context")
	}
	if c.ParentID != nil && !idPattern.MatchString(*c.ParentID) || c.GroupID != nil && !idPattern.MatchString(*c.GroupID) {
		return nil, errors.New("invalid context parent")
	}
	if !strings.Contains("|post|comment|reaction|profile|group|media|report|export|", "|"+c.Kind+"|") || !strings.Contains("|connections|friends|family|only_me|group|moderators|", "|"+c.Audience+"|") {
		return nil, errors.New("invalid context kind or audience")
	}
	created, err := time.Parse("2006-01-02T15:04:05.000Z", c.CreatedAt)
	if err != nil || created.After(time.Now().Add(5*time.Minute)) {
		return nil, errors.New("invalid creation time")
	}
	if c.ExpiresAt != nil {
		expiry, err := time.Parse("2006-01-02T15:04:05.000Z", *c.ExpiresAt)
		if err != nil || !expiry.After(created) || !expiry.After(time.Now()) {
			return nil, errors.New("invalid or expired content")
		}
	}
	return &c, nil
}
func (s *Session) Encrypt(contextJSON, payloadJSON, recipientsJSON string) (string, error) {
	if err := s.check(); err != nil {
		return "", err
	}
	c, err := validateContext([]byte(contextJSON))
	if err != nil {
		return "", err
	}
	var recipients []recipient
	if err = json.Unmarshal([]byte(recipientsJSON), &recipients); err != nil {
		return "", err
	}
	if len(recipients) == 0 || len(recipients) > 4000 {
		return "", errors.New("invalid recipients")
	}
	sort.Slice(recipients, func(i, j int) bool { return recipients[i].DeviceID < recipients[j].DeviceID })
	ring, err := pgp.NewKeyRing(nil)
	if err != nil {
		return "", err
	}
	refs := make([]reference, 0, len(recipients))
	seen := map[string]bool{}
	self := false
	for _, r := range recipients {
		if !idPattern.MatchString(r.DeviceID) || !idPattern.MatchString(r.MemberID) || seen[r.DeviceID] {
			return "", errors.New("invalid or duplicate recipient")
		}
		seen[r.DeviceID] = true
		k, err := pgp.NewKeyFromArmored(r.PublicKey)
		if err != nil {
			return "", err
		}
		if k.IsPrivate() || len(k.GetFingerprint()) != 64 {
			return "", errors.New("v6 public recipient key required")
		}
		if err = ring.AddKey(k); err != nil {
			return "", err
		}
		refs = append(refs, reference{r.MemberID, r.DeviceID, k.GetFingerprint()})
		if r.MemberID == c.AuthorID && r.DeviceID == c.AuthorDeviceID && k.GetFingerprint() == s.key.GetFingerprint() {
			self = true
		}
	}
	if !self {
		return "", errors.New("signing device must be a recipient")
	}
	var payload any
	dec := json.NewDecoder(strings.NewReader(payloadJSON))
	dec.UseNumber()
	if err = dec.Decode(&payload); err != nil {
		return "", err
	}
	binding := map[string]any{"v": 1, "protocol": protocol, "context": json.RawMessage(contextJSON), "recipients": refs, "payload": payload}
	plain, err := marshal(binding)
	if err != nil {
		return "", err
	}
	if len(plain) > maxPlaintext {
		return "", errors.New("content exceeds size limit")
	}
	encryptor, err := handle().Encryption().Recipients(ring).SigningKey(s.key).New()
	if err != nil {
		return "", err
	}
	message, err := encryptor.Encrypt(plain)
	if err != nil {
		return "", err
	}
	ciphertext, err := message.Armor()
	if err != nil {
		return "", err
	}
	result, err := marshal(envelope{1, protocol, json.RawMessage(contextJSON), refs, ciphertext})
	return string(result), err
}
func (s *Session) Decrypt(envelopeJSON, expectedContextJSON, authorPublicKey string) (string, error) {
	if err := s.check(); err != nil {
		return "", err
	}
	var e envelope
	if err := json.Unmarshal([]byte(envelopeJSON), &e); err != nil {
		return "", err
	}
	if e.V != 1 || e.Protocol != protocol || len(e.Ciphertext) > maxCiphertext || len(e.Recipients) == 0 || len(e.Recipients) > 4000 {
		return "", errors.New("invalid encrypted envelope")
	}
	c, err := validateContext(e.Context)
	if err != nil {
		return "", err
	}
	if !equalJSON(e.Context, []byte(expectedContextJSON)) {
		return "", errors.New("content context mismatch")
	}
	author, err := pgp.NewKeyFromArmored(authorPublicKey)
	if err != nil {
		return "", err
	}
	isAuthor, isRecipient := false, false
	for _, r := range e.Recipients {
		if r.MemberID == c.AuthorID && r.DeviceID == c.AuthorDeviceID && r.Fingerprint == author.GetFingerprint() {
			isAuthor = true
		}
		if r.Fingerprint == s.key.GetFingerprint() {
			isRecipient = true
		}
	}
	if !isAuthor || !isRecipient {
		return "", errors.New("author or recipient fingerprint mismatch")
	}
	if err = requireAEAD(e.Ciphertext); err != nil {
		return "", err
	}
	decryptor, err := handle().Decryption().DecryptionKey(s.key).VerificationKey(author).MaxDecompressedMessageSize(maxPlaintext).New()
	if err != nil {
		return "", err
	}
	result, err := decryptor.Decrypt([]byte(e.Ciphertext), pgp.Armor)
	if err != nil {
		return "", err
	}
	if err = result.SignatureError(); err != nil {
		return "", err
	}
	if len(result.Signatures) != 1 {
		return "", errors.New("exactly one author signature required")
	}
	plain := result.Bytes()
	if len(plain) > maxPlaintext {
		return "", errors.New("content exceeds size limit")
	}
	var decoded map[string]json.RawMessage
	if err = json.Unmarshal(plain, &decoded); err != nil {
		return "", err
	}
	payload, ok := decoded["payload"]
	if !ok {
		return "", errors.New("missing payload")
	}
	delete(decoded, "payload")
	inner, err := marshal(decoded)
	if err != nil {
		return "", err
	}
	var outer map[string]json.RawMessage
	if err = json.Unmarshal([]byte(envelopeJSON), &outer); err != nil {
		return "", err
	}
	delete(outer, "ciphertext")
	expected, err := marshal(outer)
	if err != nil {
		return "", err
	}
	if !equalJSON(inner, expected) {
		return "", errors.New("signed content binding mismatch")
	}
	return string(payload), nil
}
func (s *Session) Sign(statementJSON string) (string, error) {
	if err := s.check(); err != nil {
		return "", err
	}
	data, err := canonical(statementJSON)
	if err != nil {
		return "", err
	}
	signer, err := handle().Sign().SigningKey(s.key).Detached().New()
	if err != nil {
		return "", err
	}
	signature, err := signer.Sign(data, pgp.Armor)
	if err != nil {
		return "", err
	}
	b, err := marshal(map[string]any{"statement": json.RawMessage(data), "signature": string(signature)})
	return string(b), err
}
func VerifyStatement(signedJSON, publicKey string) (string, error) {
	var signed struct {
		Statement json.RawMessage `json:"statement"`
		Signature string          `json:"signature"`
	}
	if err := json.Unmarshal([]byte(signedJSON), &signed); err != nil {
		return "", err
	}
	key, err := pgp.NewKeyFromArmored(publicKey)
	if err != nil {
		return "", err
	}
	data, err := canonical(string(signed.Statement))
	if err != nil {
		return "", err
	}
	verifier, err := handle().Verify().VerificationKey(key).MaxDecompressedMessageSize(maxPlaintext).New()
	if err != nil {
		return "", err
	}
	result, err := verifier.VerifyDetached(data, []byte(signed.Signature), pgp.Armor)
	if err != nil {
		return "", err
	}
	if err = result.SignatureError(); err != nil {
		return "", err
	}
	return string(data), nil
}
func ReactionTag(secret, targetID, memberID, emoji string) (string, error) {
	if err := checkSecret(secret); err != nil {
		return "", err
	}
	if !idPattern.MatchString(targetID) || !idPattern.MatchString(memberID) || !regexp.MustCompile(`^[a-z0-9_-]{1,40}$`).MatchString(emoji) {
		return "", errors.New("invalid reaction")
	}
	key, err := base64.RawURLEncoding.DecodeString(secret)
	if err != nil {
		return "", err
	}
	defer clear(key)
	data, err := marshal(map[string]string{"purpose": "porchday-reaction-v1", "targetId": targetID, "memberId": memberID, "emoji": emoji})
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(data)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// EncryptArchive returns raw OpenPGP packet bytes; callers keep the separate random secret outside the file.
func EncryptArchive(data []byte, secret string) ([]byte, error) {
	if err := checkSecret(secret); err != nil {
		return nil, err
	}
	if len(data) > maxPlaintext {
		return nil, errors.New("export too large; split into parts")
	}
	enc, err := handle().Encryption().Password([]byte(secret)).New()
	if err != nil {
		return nil, err
	}
	message, err := enc.Encrypt(data)
	if err != nil {
		return nil, err
	}
	return message.Bytes(), nil
}
func DecryptArchive(data []byte, secret string) ([]byte, error) {
	if err := checkSecret(secret); err != nil {
		return nil, err
	}
	if len(data) > maxCiphertext {
		return nil, errors.New("archive too large")
	}
	dec, err := handle().Decryption().Password([]byte(secret)).MaxDecompressedMessageSize(maxPlaintext).New()
	if err != nil {
		return nil, err
	}
	result, err := dec.Decrypt(data, pgp.Bytes)
	if err != nil {
		return nil, err
	}
	if len(result.Bytes()) > maxPlaintext {
		return nil, fmt.Errorf("decrypted archive too large")
	}
	return result.Bytes(), nil
}

func requireAEAD(ciphertext string) error {
	block, err := armor.Decode(strings.NewReader(ciphertext))
	if err != nil {
		return err
	}
	reader := packet.NewReader(block.Body)
	for i := 0; i < 4002; i++ {
		p, err := reader.Next()
		if err != nil {
			return err
		}
		if encrypted, ok := p.(*packet.SymmetricallyEncrypted); ok {
			if encrypted.IntegrityProtected && encrypted.Version == 2 {
				return nil
			}
			return errors.New("RFC9580 authenticated encryption required")
		}
	}
	return errors.New("encrypted data packet missing")
}
