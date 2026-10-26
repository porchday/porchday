import SwiftUI
import PhotosUI

struct ProfileEditor: View {
    let profile: JSON
    let submitted: () -> Void
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var vault: CryptoVault
    @Environment(\.dismiss) private var dismiss
    @State private var name=""
    @State private var bio=""
    @State private var interests=""
    @State private var status=""
    @State private var theme="sage"
    @State private var font="serif"
    @State private var order="about-first"
    @State private var wallpaper: ProfileWallpaper = .none
    @State private var wallpaperChanged = false
    @State private var slot="avatar"
    @State private var selection:PhotosPickerItem?
    @State private var assets:[String:PreparedPhoto]=[:]
    @State private var removedAssets: Set<String> = []
    @State private var committedProfile: JSON?
    @State private var busy=false
    private var currentProfile: JSON { committedProfile ?? profile }
    var body:some View {
        Form {
            Section("The person behind the handle") {
                TextField("Display name",text:$name)
                TextField("Status",text:$status)
                TextField("About me",text:$bio,axis:.vertical)
                TextField("Interests, separated by commas",text:$interests)
            }
            Section("A few pictures of you") {
                Picker("Photo position",selection:$slot) { Text("Profile photo").tag("avatar");Text("Cover photo").tag("cover");Text("Wall background").tag("background") }
                PhotosPicker(selection:$selection,matching:.images) { Label("Choose photo",systemImage:"photo") }
                ForEach(["avatar","cover","background"],id:\.self) { key in
                    if let asset=assets[key] {
                        VStack(alignment:.leading) {
                            Text(key.capitalized).font(.headline)
                            if let image=UIImage(data:asset.bytes) { Image(uiImage:image).resizable().scaledToFit().frame(maxHeight:130) }
                            TextField("Photo description",text:Binding(get:{assets[key]?.alt ?? ""},set:{value in assets[key]?.alt=value}))
                            Button("Cancel selected photo") { assets.removeValue(forKey:key) }
                        }
                    } else if currentProfile[key]["id"].string != nil {
                        VStack(alignment: .leading) {
                            Text(key.capitalized).font(.headline)
                            if removedAssets.contains(key) {
                                Text("This photo will be removed when you save. Copies already saved by others cannot be recalled.").font(.footnote)
                                Button("Undo removal") { removedAssets.remove(key) }
                                    .accessibilityLabel("Undo removal of \(key) photo")
                            } else {
                                EncryptedPhotoView(photo: currentProfile[key]).frame(maxHeight: 130)
                                Button("Remove current photo", role: .destructive) { removedAssets.insert(key) }
                                    .accessibilityLabel("Remove current \(key) photo")
                            }
                        }
                    }
                }
                Text("Location metadata is removed before photos are encrypted.").font(.footnote)
            }
            Section("Personalization") {
                Picker("Tiled wallpaper", selection: Binding(get: { wallpaper }, set: { wallpaper = $0; wallpaperChanged = true })) {
                    ForEach(ProfileWallpaper.allCases) { choice in Text(choice.label).tag(choice) }
                }
                if wallpaper != .none { WallpaperBackground(wallpaper: wallpaper).frame(height: 120).clipShape(RoundedRectangle(cornerRadius: 8)).accessibilityLabel(wallpaper.label + " preview") }
                Picker("Theme",selection:$theme) { Text("Sage").tag("sage");Text("Apricot").tag("apricot");Text("Lavender").tag("lavender");Text("Ink").tag("ink") }
                Picker("Heading style",selection:$font) { Text("Serif").tag("serif");Text("Sans serif").tag("sans") }
                Picker("Section order",selection:$order) { Text("About, then interests").tag("about-first");Text("Interests, then about").tag("interests-first") }
                Text("These details are encrypted for your current connections. Share your profile again after accepting new connections.").font(.footnote)
                Button(busy ? "Encrypting your profile…":"Save and share profile") { Task { await save() } }.disabled(busy || name.count>80 || bio.count>1000 || status.count>100 || interests.count>300)
            }
        }.disabled(busy || !model.canWriteSocial).navigationTitle("Edit profile").toolbar { Button("Cancel") { dismiss() }.disabled(busy) }
            .task { name=profile["displayName"].string ?? "";bio=profile["bio"].string ?? "";interests=profile["interests"].string ?? "";status=profile["status"].string ?? "";theme=profile["theme"].string ?? "sage";font=profile["font"].string ?? "serif";order=profile["sectionOrder"].string ?? "about-first";wallpaper=ProfileWallpaper.displayed(profile["wallpaper"]) }
            .onChange(of:selection) { _,item in let targetSlot=slot;Task { await model.perform { if let data=try await item?.loadTransferable(type:Data.self) { assets[targetSlot]=try PhotoPipeline.prepare(data);removedAssets.remove(targetSlot) } } } }
    }
    private func save() async {
        busy=true;defer{busy=false}
        await model.perform {
            guard let member=model.member else{return}
            try member.access.requireSocialWrite()
            let plan = SurfacePhotoRemoval(payload: currentProfile, slots: ["avatar", "cover", "background"], removed: removedAssets, replaced: Set(assets.keys))
            var payload=plan.payload.replacing("displayName",with:.string(name)).replacing("bio",with:.string(bio)).replacing("interests",with:.string(interests)).replacing("status",with:.string(status)).replacing("theme",with:.string(theme)).replacing("font",with:.string(font)).replacing("sectionOrder",with:.string(order))
            payload = ProfileWallpaper.applying(wallpaper, to: payload, changed: wallpaperChanged)
            var attachments:[(String,String)]=[]
            for (slot,photo) in assets {
                let meta=try await model.uploadSurfacePhoto(photo,audience:"connections",parent:member.id)
                guard let photoID=meta["id"].string else{throw PorchError.message("Photo upload is unavailable.")}
                payload=payload.replacing(slot,with:meta);attachments.append((photoID,slot))
            }
            for slot in ["avatar","cover","background"] where assets[slot]==nil && payload[slot] != .null {
                let photo=try await model.reshareSurfacePhoto(payload[slot],audience:"connections",parent:member.id)
                payload=payload.replacing(slot,with:photo);attachments.append((photo["id"].string ?? "",slot))
            }
            let previous=try await model.api.social("/me")["envelope"]["context"]
            let original:JSON = .object(["id":.string(member.id),"kind":.string("profile"),"createdAt":.string(PorchDate.string()),"revision":.number(Double((previous["revision"].integer ?? 0)+1))])
            let envelope=try await vault.seal(payload,member:member,kind:"profile",audience:"connections",id:member.id,original:original)
            do {
                _ = try await model.api.social("/profiles/me",method:"PUT",body:.object(["envelope":envelope, "remove_media": plan.removals]))
            } catch PorchError.api(let code, _, _) where ["MEDIA_ATTACHMENT_CHANGED", "REVISION_CHANGED"].contains(code) {
                throw PorchError.message("Your profile changed elsewhere. Close this editor and reopen it to review the current photos before removing one.")
            }
            committedProfile = payload; assets.removeAll(); removedAssets.removeAll()
            for (photoID,slot) in attachments { _ = try await model.api.social("/media/"+photoID+"/attachment",method:"PUT",body:.object(["kind":.string("profile"),"target_id":.string(member.id),"slot":.string(slot)])) }
            submitted();dismiss()
        }
    }
}
