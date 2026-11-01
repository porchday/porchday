import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";
import { get, items, type Content, type Json } from "./api";
import { useVault } from "./vault";
export type PersonTag = { id: string; kind: "member" | "child"; label: string };
export type ChildRecord = Json & {
  id: string;
  owner_id: string;
  revision: number;
  delegates: string[];
  name: string;
  birthday?: string;
  can_post: boolean;
};
type Directory = {
  people: PersonTag[];
  children: ChildRecord[];
  error: string;
  more: boolean;
  loading: boolean;
  loadMore: () => void;
  ensure: () => void;
  reload: () => void;
};
const Context = createContext<Directory>({
  people: [],
  children: [],
  error: "",
  more: false,
  loading: false,
  loadMore: () => {},
  ensure: () => {},
  reload: () => {},
});
export function PeopleDirectory({ children }: { children: React.ReactNode }) {
  const vault = useVault(),
    [value, setValue] = useState<
      Omit<Directory, "reload" | "ensure" | "more" | "loading" | "loadMore">
    >({
      people: [],
      children: [],
      error: "",
    }),
    [version, setVersion] = useState(0),
    [enabled, setEnabled] = useState(false),
    [cursor, setCursor] = useState(""),
    [next, setNext] = useState<string | null>(null),
    [loading, setLoading] = useState(false);
  const ensure = useCallback(() => setEnabled(true), []);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    if (!cursor) setValue({ people: [], children: [], error: "" });
    setLoading(true);
    Promise.all([
      get("/connections"),
      get("/children" + (cursor ? "?after=" + encodeURIComponent(cursor) : "")),
    ])
      .then(async ([connections, result]) => {
        const people: PersonTag[] = [
          { id: vault.member.id, kind: "member", label: vault.member.handle },
        ];
        const ids = new Set(
          items<Json>(connections).flatMap((r) => [r.member_a, r.member_b]),
        );
        for (const h of connections.handles || [])
          if (h.id !== vault.member.id && ids.has(h.id))
            people.push({ id: h.id, kind: "member", label: h.handle });
        const records: ChildRecord[] = [];
        let unavailable = 0;
        for (const row of items<Json>(result)) {
          try {
            const name = await vault.open({
              id: row.id,
              author_id: row.owner_id,
              envelope: row.envelope,
            });
            if (
              typeof name.name !== "string" ||
              !name.name.trim() ||
              name.name.length > 100
            )
              continue;
            let birthday: string | undefined;
            if (row.private_envelope) {
              const detail = await vault.open({
                id: row.id,
                author_id: row.owner_id,
                envelope: row.private_envelope,
              });
              if (typeof detail.birthday === "string")
                birthday = detail.birthday;
            }
            records.push({ ...row, name: name.name, birthday } as ChildRecord);
            people.push({ id: row.id, kind: "child", label: name.name });
          } catch {
            unavailable++;
          }
        }
        if (alive) {
          setNext(result.next_id || null);
          setValue((old) => {
            const all = [
              ...new Map(
                [...(cursor ? old.children : []), ...records].map((c) => [
                  c.id,
                  c,
                ]),
              ).values(),
            ];
            return {
              people: [
                ...people.filter((p) => p.kind === "member"),
                ...all.map((c) => ({
                  id: c.id,
                  kind: "child" as const,
                  label: c.name,
                })),
              ],
              children: all,
              error: unavailable
                ? `${unavailable} child profiles could not be opened on this device. Their parent may need to save the profile again for new connections.`
                : "",
            };
          });
        }
      })
      .catch(() => {
        if (alive)
          setValue({
            people: [],
            children: [],
            error: "People could not be loaded. Try again before tagging.",
          });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [vault.member.id, version, enabled, cursor]);
  useEffect(() => {
    const refresh = () => {
      setCursor("");
      setVersion((v) => v + 1);
    };
    window.addEventListener("porchday:connections-changed", refresh);
    return () =>
      window.removeEventListener("porchday:connections-changed", refresh);
  }, []);
  return (
    <Context.Provider
      value={{
        ...value,
        ensure,
        more: Boolean(next),
        loading,
        loadMore: () => {
          if (next && !loading) setCursor(next);
        },
        reload: () => {
          setEnabled(true);
          setCursor("");
          setVersion((v) => v + 1);
        },
      }}
    >
      {children}
    </Context.Provider>
  );
}
export const usePeopleDirectory = () => useContext(Context);
export function validTags(value: unknown): PersonTag[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (v): v is PersonTag =>
        v &&
        typeof v.id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          v.id,
        ) &&
        (v.kind === "member" || v.kind === "child") &&
        typeof v.label === "string" &&
        v.label.length <= 100,
    )
    .slice(0, 30);
}
export function TagPicker({
  value,
  onChange,
  label = "Tag people",
  disabled = false,
}: {
  value: PersonTag[];
  onChange: (tags: PersonTag[]) => void;
  label?: string;
  disabled?: boolean;
}) {
  const directory = usePeopleDirectory();
  const [choosing, setChoosing] = useState(false);
  if (!choosing && !value.length)
    return (
      <button
        type="button"
        className="text-button"
        onClick={() => {
          directory.ensure();
          setChoosing(true);
        }}
      >
        {label}
      </button>
    );
  return (
    <div className="people-tag-picker">
      <label>
        {label}
        <select
          onFocus={directory.ensure}
          aria-label={label}
          value=""
          disabled={disabled || value.length >= 30}
          onChange={(e) => {
            const person = directory.people.find(
              (p) => p.kind + ":" + p.id === e.target.value,
            );
            if (person) onChange([...value, person]);
          }}
        >
          <option value="">Choose a person…</option>
          {directory.people
            .filter(
              (p) => !value.some((t) => t.id === p.id && t.kind === p.kind),
            )
            .map((p) => (
              <option key={p.kind + p.id} value={p.kind + ":" + p.id}>
                {p.kind === "member" ? "@" : ""}
                {p.label}
                {p.kind === "child" ? " (child)" : ""}
              </option>
            ))}
        </select>
      </label>
      {directory.loading && <p role="status">Loading people…</p>}
      {directory.more && (
        <button
          type="button"
          disabled={directory.loading}
          onClick={directory.loadMore}
        >
          Load more children
        </button>
      )}
      <div className="people-tags">
        {value.map((p) => (
          <button
            type="button"
            disabled={disabled}
            key={p.kind + p.id}
            onClick={() =>
              onChange(value.filter((t) => t.id !== p.id || t.kind !== p.kind))
            }
            aria-label={`Remove tag ${p.label}`}
          >
            {p.label} ×
          </button>
        ))}
      </div>
      {directory.error && (
        <p role="alert">
          {directory.error}{" "}
          <button type="button" onClick={directory.reload}>
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
export function Tags({ value }: { value: unknown }) {
  return (
    <span className="people-tags">
      {validTags(value).map((p) =>
        p.kind === "member" ? (
          <a key={p.id} href={`/app/wall/${encodeURIComponent(p.id)}`}>
            @{p.label}
          </a>
        ) : (
          <span key={p.id}>{p.label}</span>
        ),
      )}
    </span>
  );
}
export function contentTags(content: Content): PersonTag[] {
  return [
    ...validTags(content.tags),
    ...(content.media || []).flatMap((m) => validTags(m.tags)),
  ];
}
