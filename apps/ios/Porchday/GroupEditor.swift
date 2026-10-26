import SwiftUI
import PhotosUI

struct GroupEditor: View {
    let id: String
    let payload: JSON
    let context: JSON
    let submitted: () -> Void
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var selection: PhotosPickerItem?
    @State private var photo: PreparedPhoto?
    @State private var removePhoto = false
    @State private var committedPayload: JSON?
    @State private var committedContext: JSON?
    @State private var busy = false
    private var currentPayload: JSON { committedPayload ?? payload }

    var body: some View {
        Form {
            Section("Group details") {
                TextField("Group name", text: $name)
                TextField("Description", text: $description, axis: .vertical)
                PhotosPicker(selection: $selection, matching: .images) { Label("Choose a group image", systemImage: "photo") }
                if let photo {
                    if let image = UIImage(data: photo.bytes) { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 180) }
                    TextField("Photo description", text: Binding(get: { self.photo?.alt ?? "" }, set: { self.photo?.alt = $0 }))
                    Button("Cancel selected photo") { self.photo = nil }
                } else if currentPayload["image"]["id"].string != nil {
                    if removePhoto {
                        Text("This photo will be removed when you save. Copies already saved by others cannot be recalled.").font(.footnote)
                        Button("Undo removal") { removePhoto = false }
                            .accessibilityLabel("Undo removal of group image")
                    } else {
                        EncryptedPhotoView(photo: currentPayload["image"]).frame(maxHeight: 180)
                        Button("Remove current photo", role: .destructive) { removePhoto = true }
                            .accessibilityLabel("Remove current group image")
                    }
                }
            }
            Section {
                Text("Saving shares the name, description and image with the group's current members. Earlier posts and comments keep their original audiences.").font(.footnote)
                Button(busy ? "Encrypting group details…" : "Save and share group details") { Task { await save() } }
                    .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 80 || description.count > 1000)
            }
        }
        .disabled(busy || !model.canWriteSocial)
        .navigationTitle("Group details")
        .toolbar { Button("Cancel") { dismiss() }.disabled(busy) }
        .task { name = payload["name"].string ?? ""; description = payload["description"].string ?? "" }
        .onChange(of: selection) { _, item in Task { await model.perform { if let bytes = try await item?.loadTransferable(type: Data.self) { photo = try PhotoPipeline.prepare(bytes); removePhoto = false } } } }
    }
    private func save() async {
        busy = true; defer { busy = false }
        await model.perform {
            guard let member = model.member else { return }
            try member.access.requireSocialWrite()
            let plan = SurfacePhotoRemoval(payload: currentPayload, slots: ["image"], removed: removePhoto ? ["image"] : [], replaced: photo == nil ? [] : ["image"])
            var updated = plan.payload.replacing("name", with: .string(name.trimmingCharacters(in: .whitespacesAndNewlines)))
                .replacing("description", with: .string(description))
            if let photo { updated = updated.replacing("image", with: try await model.uploadSurfacePhoto(photo, audience: "group", parent: id, group: id)) }
            else if updated["image"] != .null { updated = updated.replacing("image", with: try await model.reshareSurfacePhoto(updated["image"], audience: "group", parent: id, group: id)) }
            let previous = committedContext ?? context
            let next = previous.replacing("revision", with: .number(Double((previous["revision"].integer ?? 0) + 1)))
            let envelope = try await vault.seal(updated, member: member, kind: "group", audience: "group", id: id, group: id, original: next)
            do {
                _ = try await model.api.social("/groups/" + id, method: "PUT", body: .object(["envelope": envelope, "remove_media": plan.removals]))
            } catch PorchError.api(let code, _, _) where ["MEDIA_ATTACHMENT_CHANGED", "REVISION_CHANGED"].contains(code) {
                throw PorchError.message("This group changed elsewhere. Close this editor and reopen it to review the current photo before removing it.")
            }
            committedPayload = updated; committedContext = envelope["context"]; self.photo = nil; removePhoto = false
            if let photoID = updated["image"]["id"].string {
                _ = try await model.api.social("/media/" + photoID + "/attachment", method: "PUT", body: .object(["kind": .string("group"), "target_id": .string(id), "slot": .string("image")]))
            }
            submitted(); dismiss()
        }
    }
}
