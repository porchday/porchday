import React, { useState, useEffect } from "react";
import { request, del } from "./api";
import { useVault } from "./vault";
import { Alert, Button, Field, useAction } from "./ui";
import { usePeopleDirectory, type ChildRecord } from "./PeopleTags";
export function ChildrenSettings() {
  const vault = useVault(),
    directory = usePeopleDirectory(),
    action = useAction();
  useEffect(() => directory.ensure(), [directory.ensure]);
  const [edit, setEdit] = useState<ChildRecord | null>(null),
    [name, setName] = useState(""),
    [birthday, setBirthday] = useState(""),
    [delegates, setDelegates] = useState<string[]>([]),
    [draft, setDraft] = useState(false),
    [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());
  function start(child?: ChildRecord) {
    setDraftId(child?.id ?? crypto.randomUUID());
    setEdit(child ?? null);
    setName(child?.name ?? "");
    setBirthday(child?.birthday ?? "");
    setDelegates(child?.delegates ?? []);
    setDraft(true);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    await action.runSave(async () => {
      if (!name.trim()) throw new Error("Enter a name.");
      if (
        birthday &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(birthday) ||
          new Date(birthday).toISOString().slice(0, 10) !== birthday ||
          Date.parse(birthday) > Date.now())
      )
        throw new Error("Enter a valid birthday in the past.");
      const id = draftId,
        revision = (edit?.revision ?? 0) + 1;
      const envelope = await vault.seal(
        { name: name.trim() },
        { id, kind: "profile", audience: "connections", revision },
      );
      const private_envelope = await vault.seal(
        { birthday },
        { id, kind: "profile", audience: "only_me", revision },
      );
      await request(`/children/${id}`, {
        method: "PUT",
        body: JSON.stringify({ envelope, private_envelope, delegates }),
      });
      setDraft(false);
      directory.reload();
    }, "Child profile saved.");
  }
  return (
    <section className="panel form-stack">
      <h2>Children</h2>
      <p>
        Add a child without creating a login. Their name is encrypted for your
        connections so they can tag the child. Their birthday is encrypted for
        your own devices only. Tags never change a post’s audience.
      </p>
      <Alert>{action.error || directory.error}</Alert>
      <Alert success>{action.notice}</Alert>
      {directory.children
        .filter((c) => c.owner_id === vault.member.id)
        .map((c) => (
          <div key={c.id} className="member-row">
            <strong>{c.name}</strong>
            <Button type="button" onClick={() => start(c)}>
              Edit
            </Button>
            <Button
              type="button"
              busy={action.busy}
              onClick={() => {
                if (
                  window.confirm(
                    `Remove ${c.name} and their posting permissions? Existing encrypted posts and tags remain with their readers.`,
                  )
                )
                  void action.runSave(async () => {
                    await del(`/children/${c.id}`);
                    directory.reload();
                  }, "Child profile removed.");
              }}
            >
              Remove
            </Button>
          </div>
        ))}
      {!draft ? (
        <Button type="button" onClick={() => start()}>
          Add child
        </Button>
      ) : (
        <form className="form-stack" data-unsaved-draft="true" onSubmit={save}>
          <Field
            label="Child’s name"
            value={name}
            maxLength={100}
            required
            onChange={(e) => setName(e.target.value)}
          />
          <Field
            label="Birthday (private to you)"
            type="date"
            value={birthday}
            onChange={(e) => setBirthday(e.target.value)}
          />
          <fieldset>
            <legend>Who else can post on this child’s behalf?</legend>
            <p>
              The adult remains the author and chooses their own post audience.
              You can revoke this permission here.
            </p>
            {directory.people
              .filter((p) => p.kind === "member" && p.id !== vault.member.id)
              .map((p) => (
                <label className="checkbox-row" key={p.id}>
                  <input
                    type="checkbox"
                    checked={delegates.includes(p.id)}
                    onChange={(e) =>
                      setDelegates(
                        e.target.checked
                          ? [...delegates, p.id]
                          : delegates.filter((id) => id !== p.id),
                      )
                    }
                  />
                  @{p.label}
                </label>
              ))}
          </fieldset>
          <div className="button-row">
            <Button busy={action.busy} type="submit">
              Save child
            </Button>
            <Button type="button" onClick={() => setDraft(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
