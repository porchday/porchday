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
    @State private var busy = false

    var body: some View {
        Form {
            Section("Your shared space") {
                TextField("Group name", text: $name)
                TextField("Description", text: $description, axis: .vertical)
                PhotosPicker(selection: $selection, matching: .images) { Label("Choose a group image", systemImage: "photo") }
                if let photo {
                    if let image = UIImage(data: photo.bytes) { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 180) }
                    TextField("Photo description", text: Binding(get: { self.photo?.alt ?? "" }, set: { self.photo?.alt = $0 }))
                } else if payload["image"] != .null { EncryptedPhotoView(photo: payload["image"]).frame(maxHeight: 180) }
            }
            Section {
                Text("Saving shares the name, description and image with the group's current members. Earlier posts and comments keep their original audiences.").font(.footnote)
                Button(busy ? "Encrypting group details…" : "Save and share group details") { Task { await save() } }
                    .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 80 || description.count > 1000)
            }
        }
        .navigationTitle("Group details")
        .toolbar { Button("Cancel") { dismiss() } }
        .task { name = payload["name"].string ?? ""; description = payload["description"].string ?? "" }
        .onChange(of: selection) { _, item in Task { await model.perform { if let bytes = try await item?.loadTransferable(type: Data.self) { photo = try PhotoPipeline.prepare(bytes) } } } }
    }
    private func save() async {
        busy = true; defer { busy = false }
        await model.perform {
            guard let member = model.member else { return }
            var updated = payload.replacing("name", with: .string(name.trimmingCharacters(in: .whitespacesAndNewlines)))
                .replacing("description", with: .string(description))
            if let photo { updated = updated.replacing("image", with: try await model.uploadSurfacePhoto(photo, audience: "group", parent: id, group: id)) }
            else if updated["image"] != .null { updated = updated.replacing("image", with: try await model.reshareSurfacePhoto(updated["image"], audience: "group", parent: id, group: id)) }
            let next = context.replacing("revision", with: .number(Double((context["revision"].integer ?? 0) + 1)))
                .replacing("createdAt", with: .string(PorchDate.string()))
            let envelope = try await vault.seal(updated, member: member, kind: "group", audience: "group", id: id, group: id, original: next)
            _ = try await model.api.social("/groups/" + id, method: "PUT", body: .object(["envelope": envelope]))
            if let photoID = updated["image"]["id"].string {
                _ = try await model.api.social("/media/" + photoID + "/attachment", method: "PUT", body: .object(["kind": .string("group"), "target_id": .string(id), "slot": .string("image")]))
            }
            submitted(); dismiss()
        }
    }
}
