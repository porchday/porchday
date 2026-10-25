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
    @State private var slot="avatar"
    @State private var selection:PhotosPickerItem?
    @State private var assets:[String:PreparedPhoto]=[:]
    @State private var busy=false
    var body:some View {
        Form {
            Section("The person behind the handle") {
                TextField("Display name",text:$name)
                TextField("A little status",text:$status)
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
                            Button("Remove selected photo",role:.destructive) { assets.removeValue(forKey:key) }
                        }
                    }
                }
                Text("Location metadata is removed before photos are encrypted.").font(.footnote)
            }
            Section("Make this corner yours") {
                Picker("Theme",selection:$theme) { Text("Sunday garden").tag("sage");Text("Golden hour").tag("apricot");Text("After the rain").tag("lavender");Text("Library afternoon").tag("ink") }
                Picker("Heading style",selection:$font) { Text("Bookish serif").tag("serif");Text("Simple sans serif").tag("sans") }
                Picker("Section order",selection:$order) { Text("About, then interests").tag("about-first");Text("Interests, then about").tag("interests-first") }
                Text("These details are encrypted for your current connections. Share your profile again after accepting new connections.").font(.footnote)
                Button(busy ? "Encrypting your profile…":"Save and share profile") { Task { await save() } }.disabled(busy || name.count>80 || bio.count>1000 || status.count>100 || interests.count>300)
            }
        }.navigationTitle("Your personal space").toolbar { Button("Cancel") { dismiss() } }
            .task { name=profile["displayName"].string ?? "";bio=profile["bio"].string ?? "";interests=profile["interests"].string ?? "";status=profile["status"].string ?? "";theme=profile["theme"].string ?? "sage";font=profile["font"].string ?? "serif";order=profile["sectionOrder"].string ?? "about-first" }
            .onChange(of:selection) { _,item in let targetSlot=slot;Task { await model.perform { if let data=try await item?.loadTransferable(type:Data.self) { assets[targetSlot]=try PhotoPipeline.prepare(data) } } } }
    }
    private func save() async {
        busy=true;defer{busy=false}
        await model.perform {
            guard let member=model.member else{return}
            var payload=profile.replacing("displayName",with:.string(name)).replacing("bio",with:.string(bio)).replacing("interests",with:.string(interests)).replacing("status",with:.string(status)).replacing("theme",with:.string(theme)).replacing("font",with:.string(font)).replacing("sectionOrder",with:.string(order))
            for (slot,photo) in assets {
                let meta:JSON = .object(["id":.string(photo.id),"mime":.string("image/jpeg"),"alt":.string(photo.alt),"width":.number(Double(photo.width)),"height":.number(Double(photo.height))])
                let envelope=try await vault.seal(meta.replacing("bytes",with:.string(photo.bytes.base64EncodedString())),member:member,kind:"media",audience:"connections",id:photo.id,parent:member.id)
                let bytes=try JSONEncoder().encode(envelope),upload=try await model.api.social("/media",method:"POST",body:.object(["id":.string(photo.id),"envelope":envelope,"byte_size":.number(Double(bytes.count))]))
                guard let url=upload["upload_url"].string else{throw PorchError.message("Photo upload is unavailable.")};_ = try await model.api.bytes(url,method:"PUT",body:bytes);payload=payload.replacing(slot,with:meta)
            }
            let previous=try await model.api.social("/me")["envelope"]["context"]
            let original:JSON = .object(["id":.string(member.id),"kind":.string("profile"),"createdAt":.string(PorchDate.string()),"revision":.number(Double((previous["revision"].integer ?? 0)+1))])
            let envelope=try await vault.seal(payload,member:member,kind:"profile",audience:"connections",id:member.id,original:original)
            _ = try await model.api.social("/profiles/me",method:"PUT",body:.object(["envelope":envelope]))
            for (slot,photo) in assets { _ = try await model.api.social("/media/"+photo.id+"/attachment",method:"PUT",body:.object(["kind":.string("profile"),"target_id":.string(member.id),"slot":.string(slot)])) }
            submitted();dismiss()
        }
    }
}
