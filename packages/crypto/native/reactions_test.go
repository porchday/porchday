package porchcrypto

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type reactionFixture struct {
	Secret   string `json:"secret"`
	TargetID string `json:"targetId"`
	MemberID string `json:"memberId"`
	Vectors  []struct {
		Name    string `json:"name"`
		Tag     string `json:"tag"`
		Payload struct {
			Emoji string `json:"emoji"`
		} `json:"payload"`
	} `json:"vectors"`
}

func TestLegacyAndExtendedReactionTagVectors(t *testing.T) {
	raw, err := os.ReadFile("../test/fixtures/reactions-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture reactionFixture
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Vectors) != 12 {
		t.Fatal("expected twelve independent reaction vectors")
	}
	for _, row := range fixture.Vectors {
		t.Run(row.Name, func(t *testing.T) {
			actual, err := ReactionTag(fixture.Secret, fixture.TargetID, fixture.MemberID, row.Payload.Emoji)
			if err != nil || actual != row.Tag {
				t.Fatal("reaction tag differs from independent SHA-256 HMAC vector")
			}
			other, err := ReactionTag(fixture.Secret, "another-target", fixture.MemberID, row.Payload.Emoji)
			if err != nil || other == actual {
				t.Fatal("reaction target was not bound")
			}
		})
	}
	for _, id := range []string{"👍", strings.Repeat("x", 41), "u1_" + strings.Repeat("a", 63), "c1_" + strings.Repeat("A", 64), "c1_" + strings.Repeat("f", 65)} {
		if _, err := ReactionTag(fixture.Secret, fixture.TargetID, fixture.MemberID, id); err == nil {
			t.Fatal("invalid canonical reaction ID accepted")
		}
	}
}

func TestExtendedReactionCiphertextInteroperability(t *testing.T) {
	f := loadFixture(t)
	alice, bob := session(t, f.Alice), session(t, f.Bob)
	path := filepath.Join(t.TempDir(), "synthetic-reactions.json")
	if output, err := exec.Command("node", "../test/reaction-interop.ts", "generate", path).CombinedOutput(); err != nil {
		t.Fatalf("JavaScript reaction fixture failed: %s", output)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var rows struct {
		Secret    string `json:"secret"`
		TargetID  string `json:"targetId"`
		MemberID  string `json:"memberId"`
		Reactions []struct {
			Tag      string          `json:"tag"`
			Payload  json.RawMessage `json:"payload"`
			Envelope json.RawMessage `json:"envelope"`
		} `json:"reactions"`
	}
	if err = json.Unmarshal(raw, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows.Reactions) != 12 {
		t.Fatal("missing reaction interoperability cases")
	}
	recipients, _ := json.Marshal([]recipient{{"fixture-alice", "fixture-alice-phone", f.Alice.PublicKey}, {"fixture-bob", "fixture-bob-phone", f.Bob.PublicKey}})
	for index, row := range rows.Reactions {
		var env envelope
		if err = json.Unmarshal(row.Envelope, &env); err != nil {
			t.Fatal(err)
		}
		payload, err := bob.Decrypt(string(row.Envelope), string(env.Context), f.Alice.PublicKey)
		if err != nil || !equalJSON([]byte(payload), row.Payload) {
			t.Fatal("native reaction decrypt mismatch")
		}
		var descriptor struct {
			Emoji string `json:"emoji"`
		}
		if err = json.Unmarshal(row.Payload, &descriptor); err != nil {
			t.Fatal(err)
		}
		tag, err := ReactionTag(rows.Secret, rows.TargetID, rows.MemberID, descriptor.Emoji)
		if err != nil || tag != row.Tag {
			t.Fatal("native reaction tag mismatch")
		}
		sealed, err := alice.Encrypt(string(env.Context), string(row.Payload), string(recipients))
		if err != nil {
			t.Fatal(err)
		}
		rows.Reactions[index].Envelope = json.RawMessage(sealed)
	}
	raw, err = json.Marshal(rows)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("node", "../test/reaction-interop.ts", "verify", path).CombinedOutput(); err != nil {
		t.Fatalf("JavaScript native reaction verification failed: %s", output)
	} else {
		t.Log(string(output))
	}
}
