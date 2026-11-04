package porchcrypto

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

type fixtureKey struct {
	PublicKey           string `json:"publicKey"`
	EncryptedPrivateKey string `json:"encryptedPrivateKey"`
	RecoverySecret      string `json:"recoverySecret"`
	Fingerprint         string `json:"fingerprint"`
}
type fixture struct {
	Alice     fixtureKey      `json:"alice"`
	Bob       fixtureKey      `json:"bob"`
	Envelope  json.RawMessage `json:"envelope"`
	Payload   json.RawMessage `json:"payload"`
	Signature json.RawMessage `json:"signature"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	data, e := os.ReadFile("../test/fixtures/openpgp-v1.json")
	if e != nil {
		t.Fatal(e)
	}
	var f fixture
	if e = json.Unmarshal(data, &f); e != nil {
		t.Fatal(e)
	}
	return f
}
func session(t *testing.T, k fixtureKey) *Session {
	t.Helper()
	s, e := NewSession(k.EncryptedPrivateKey, k.RecoverySecret, k.Fingerprint)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(s.Close)
	return s
}
func TestJavaScriptToNative(t *testing.T) {
	f := loadFixture(t)
	bob := session(t, f.Bob)
	var env envelope
	if e := json.Unmarshal(f.Envelope, &env); e != nil {
		t.Fatal(e)
	}
	result, e := bob.Decrypt(string(f.Envelope), string(env.Context), f.Alice.PublicKey)
	if e != nil {
		t.Fatal(e)
	}
	if !equalJSON([]byte(result), f.Payload) {
		t.Fatal("payload mismatch")
	}
	if _, e = VerifyStatement(string(f.Signature), f.Alice.PublicKey); e != nil {
		t.Fatal(e)
	}
	modified := env
	modified.Context = json.RawMessage(`{"id":"changed"}`)
	raw, _ := json.Marshal(modified)
	if _, e = bob.Decrypt(string(raw), string(env.Context), f.Alice.PublicKey); e == nil {
		t.Fatal("modified context accepted")
	}
	env.Recipients[1].MemberID = "substituted"
	raw, _ = json.Marshal(env)
	if _, e = bob.Decrypt(string(raw), string(env.Context), f.Alice.PublicKey); e == nil {
		t.Fatal("modified recipient accepted")
	}
}
func TestNativeToJavaScript(t *testing.T) {
	f := loadFixture(t)
	secret, e := NewSecret()
	if e != nil {
		t.Fatal(e)
	}
	keys, e := GenerateDeviceKeys("native-author", "native-phone", secret)
	if e != nil {
		t.Fatal(e)
	}
	var key fixtureKey
	if e = json.Unmarshal([]byte(keys), &key); e != nil {
		t.Fatal(e)
	}
	s := session(t, key)
	// The existing JavaScript fixture covers connections; this reverse direction
	// verifies that the new signed friends audience interoperates unchanged.
	c := context{ID: "native-object", Kind: "post", AuthorID: "native-author", AuthorDeviceID: "native-phone", Audience: "friends", Epoch: 2, CreatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), Revision: 1}
	ctx, _ := json.Marshal(c)
	recipients, _ := json.Marshal([]recipient{{"native-author", "native-phone", key.PublicKey}, {"fixture-bob", "fixture-bob-phone", f.Bob.PublicKey}})
	payload := `{"text":"Native porch says hello 🌻","photo":"AAECA/7/"}`
	encrypted, e := s.Encrypt(string(ctx), payload, string(recipients))
	if e != nil {
		t.Fatal(e)
	}
	signed, e := s.Sign(`{"purpose":"porchday-interop-test","memberId":"native-author","nonce":"native-test"}`)
	if e != nil {
		t.Fatal(e)
	}
	tag, e := ReactionTag(secret, "native-object", "native-author", "like")
	if e != nil {
		t.Fatal(e)
	}
	archive, e := EncryptArchive([]byte("native archive bytes"), secret)
	if e != nil {
		t.Fatal(e)
	}
	data, e := json.Marshal(map[string]any{"native": json.RawMessage(keys), "bob": f.Bob, "envelope": json.RawMessage(encrypted), "payload": json.RawMessage(payload), "signature": json.RawMessage(signed), "reactionSecret": secret, "reactionTag": tag, "archive": archive})
	if e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(t.TempDir(), "native-fixture.json")
	if e = os.WriteFile(path, data, 0600); e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command("node", "../test/verify-native.ts", path)
	output, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("JS interop failed: %s", output)
	}
	t.Log(string(output))
}
func TestNativeRejectsWrongSecretsAndBinding(t *testing.T) {
	f := loadFixture(t)
	wrong, _ := NewSecret()
	if _, e := NewSession(f.Bob.EncryptedPrivateKey, wrong, f.Bob.Fingerprint); e == nil {
		t.Fatal("wrong secret accepted")
	}
	if _, e := NewSession(f.Bob.EncryptedPrivateKey, f.Bob.RecoverySecret, f.Alice.Fingerprint); e == nil {
		t.Fatal("fingerprint substitution accepted")
	}
	s := session(t, f.Alice)
	s.Close()
	if _, e := s.Sign(`{"purpose":"after-close"}`); e == nil {
		t.Fatal("closed key accepted")
	}
}

func TestPhotoAndAlbumContextParity(t *testing.T) {
	f := loadFixture(t)
	alice, bob := session(t, f.Alice), session(t, f.Bob)
	var original envelope
	if err := json.Unmarshal(f.Envelope, &original); err != nil {
		t.Fatal(err)
	}
	var base map[string]any
	if err := json.Unmarshal(original.Context, &base); err != nil {
		t.Fatal(err)
	}
	recipients, _ := json.Marshal([]recipient{{MemberID: original.Recipients[0].MemberID, DeviceID: original.Recipients[0].DeviceID, PublicKey: f.Alice.PublicKey}, {MemberID: original.Recipients[1].MemberID, DeviceID: original.Recipients[1].DeviceID, PublicKey: f.Bob.PublicKey}})
	var envelopes []json.RawMessage
	for _, kind := range []string{"album", "photo", "post"} {
		for _, audience := range []string{"community", "extended_family", "album"} {
			base["kind"], base["audience"] = kind, audience
			delete(base, "photoDate")
			if kind == "photo" {
				base["photoDate"] = "2024-02-29"
			}
			context, _ := json.Marshal(base)
			encrypted, err := alice.Encrypt(string(context), string(f.Payload), string(recipients))
			if err != nil {
				t.Fatal(err)
			}
			envelopes = append(envelopes, json.RawMessage(encrypted))
			if _, err = bob.Decrypt(encrypted, string(context), f.Alice.PublicKey); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Verify the actual OpenPGP.js decoder and reverse-direction encoder for every
	// new kind/audience pair, rather than relying only on a native round trip.
	directory := t.TempDir()
	input, output := filepath.Join(directory, "input.json"), filepath.Join(directory, "output.json")
	packed, _ := json.Marshal(map[string]any{"alice": f.Alice, "bob": f.Bob, "recipients": json.RawMessage(recipients), "payload": f.Payload, "envelopes": envelopes})
	if err := os.WriteFile(input, packed, 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", "../test/photo-native-interop.ts", input, output)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("photo/album JS interoperability failed: %s", out)
	}
	reversed, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	var results []json.RawMessage
	if err := json.Unmarshal(reversed, &results); err != nil {
		t.Fatal(err)
	}
	if len(results) != len(envelopes) {
		t.Fatal("missing reverse interop cases")
	}
	for _, raw := range results {
		var env envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		payload, err := bob.Decrypt(string(raw), string(env.Context), f.Alice.PublicKey)
		if err != nil || !equalJSON([]byte(payload), f.Payload) {
			t.Fatal("JavaScript photo/album decode mismatch", err)
		}
	}
	base["kind"] = "photo"
	for _, date := range []any{nil, "2023-02-29", "2024-02-30", "0000-01-01", "2024-2-01"} {
		if date == nil {
			delete(base, "photoDate")
		} else {
			base["photoDate"] = date
		}
		raw, _ := json.Marshal(base)
		if _, err := validateContext(raw); err == nil {
			t.Fatalf("accepted invalid date %v", date)
		}
	}
	base["kind"], base["photoDate"] = "post", "2024-02-29"
	raw, _ := json.Marshal(base)
	if _, err := validateContext(raw); err == nil {
		t.Fatal("post accepted custom date")
	}
}

func TestNativeRejectsNullPhotoDateAndUnsafeInteger(t *testing.T) {
	f := loadFixture(t)
	var env envelope
	_ = json.Unmarshal(f.Envelope, &env)
	var c map[string]any
	_ = json.Unmarshal(env.Context, &c)
	c["photoDate"] = nil
	raw, _ := json.Marshal(c)
	if _, err := validateContext(raw); err == nil {
		t.Fatal("accepted null custom date on post")
	}
	delete(c, "photoDate")
	c["revision"] = int64(9007199254740992)
	raw, _ = json.Marshal(c)
	if _, err := validateContext(raw); err == nil {
		t.Fatal("accepted unsafe revision")
	}
}
