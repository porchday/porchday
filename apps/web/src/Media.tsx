import React, { useState } from "react";
import {
  bytesToBase64,
  base64ToBytes,
  type EncryptedEnvelope,
  type Audience,
} from "@porchday/crypto";
import { post, request, type MediaPayload } from "./api";
import { EncryptedPhoto, preparePhoto } from "./Social";
import { Alert, Button, Icon, useAction } from "./ui";
import { useVault } from "./vault";
import { jpegDimensions, PHOTO_ACCEPT } from "./photo-safety";
import { preservedPhotoDeadline } from "./archive";
export type PendingAsset = {
  slot: "avatar" | "cover" | "background" | "image";
  id: string;
  blob: Blob;
  preview: string;
  name: string;
  alt: string;
  width: number;
  height: number;
};
export function AssetPicker({
  slot,
  label,
  onChange,
  asset,
  current,
  removed = false,
  onRemovalChange,
  disabled = false,
}: {
  slot: PendingAsset["slot"];
  label: string;
  onChange: (asset: PendingAsset | null) => void;
  asset: PendingAsset | null;
  current?: MediaPayload;
  removed?: boolean;
  onRemovalChange?: (removed: boolean) => void;
  disabled?: boolean;
}) {
  const action = useAction();
  return (
    <div
      className="asset-picker"
      data-unsaved-draft={Boolean(asset || removed) || undefined}
    >
      <span className="field-label">{label}</span>
      {current && !asset && !removed && (
        <div
          className={`current-asset ${slot === "avatar" ? "asset-avatar" : ""}`}
        >
          <EncryptedPhoto media={current} />
        </div>
      )}
      {asset && (
        <img
          className={slot === "avatar" ? "asset-avatar" : ""}
          src={asset.preview}
          alt="Your selected image preview"
        />
      )}
      <label className="file-button button outline compact">
        <Icon name="photo" size={16} />
        {asset ? "Choose another photo" : "Choose a photo"}
        <input
          type="file"
          disabled={disabled || action.busy}
          accept={PHOTO_ACCEPT}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              action.run(async () => {
                const prepared = await preparePhoto(
                  file,
                  slot === "avatar" ? 512 : 1800,
                );
                onChange({
                  slot,
                  id: crypto.randomUUID(),
                  name: file.name,
                  alt: "",
                  ...prepared,
                });
              });
            e.target.value = "";
          }}
        />
      </label>
      {asset && (
        <>
          <label className="field">
            <span>Image description</span>
            <input
              value={asset.alt}
              disabled={disabled || action.busy}
              maxLength={1000}
              onChange={(e) => onChange({ ...asset, alt: e.target.value })}
            />
          </label>
          <button
            type="button"
            disabled={disabled || action.busy}
            className="text-button"
            onClick={() => onChange(null)}
          >
            Cancel this photo change
          </button>
        </>
      )}
      {current && !asset && onRemovalChange && (
        <>
          {removed && (
            <p className="small-copy" role="status">
              This photo will be removed when you save. Copies already saved by
              others cannot be recalled.
            </p>
          )}
          <button
            type="button"
            className="text-button"
            disabled={disabled || action.busy}
            aria-label={`${removed ? "Undo removal of" : "Remove current"} ${label.toLowerCase()}`}
            onClick={() => onRemovalChange(!removed)}
          >
            {removed ? "Undo removal" : "Remove current photo"}
          </button>
        </>
      )}
      <Alert>{action.error}</Alert>
    </div>
  );
}
export function useAssetUpload() {
  const vault = useVault();
  return async (
    asset: PendingAsset | MediaPayload,
    parentId: string,
    groupId: string | null = null,
    audience: Audience = groupId ? "group" : "connections",
  ): Promise<MediaPayload> => {
    let photoBytes: Uint8Array;
    let expiresAt: string | null = null;
    if ("blob" in asset)
      photoBytes = new Uint8Array(await asset.blob.arrayBuffer());
    else {
      const response = await fetch(`/api/v1/media/${asset.id}/bytes`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          "A current profile or group photo is no longer available. Choose a replacement before sharing these details.",
        );
      const envelope = (await response.json()) as EncryptedEnvelope;
      const content = await vault.open({ envelope, id: asset.id });
      if (content.mime !== "image/jpeg" || typeof content.bytes !== "string")
        throw new Error("A current image has an unsupported format.");
      photoBytes = base64ToBytes(content.bytes);
      expiresAt = preservedPhotoDeadline(envelope.context.expiresAt, null);
    }
    const dimensions = jpegDimensions(photoBytes);
    const meta: MediaPayload = {
      id: crypto.randomUUID(),
      alt: asset.alt,
      mime: "image/jpeg",
      name: asset.name,
      ...dimensions,
    };
    const envelope = await vault.seal(
      { ...meta, bytes: bytesToBase64(photoBytes) },
      { id: meta.id, kind: "media", audience, parentId, groupId, expiresAt },
    );
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    const upload = await post("/media", {
      id: meta.id,
      envelope,
      byte_size: bytes.length,
    });
    await request(upload.upload_url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([bytes]),
    });
    return meta;
  };
}
