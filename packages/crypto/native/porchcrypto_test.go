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
	c := context{ID: "native-object", Kind: "post", AuthorID: "native-author", AuthorDeviceID: "native-phone", Audience: "connections", Epoch: 2, CreatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), Revision: 1}
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
