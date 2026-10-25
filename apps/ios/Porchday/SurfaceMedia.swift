import Foundation

@MainActor extension AppModel {
    func uploadSurfacePhoto(_ photo: PreparedPhoto, audience: String, parent: String, group: String? = nil) async throws -> JSON {
        guard let member else { throw PorchError.message("Sign in before sharing a photo.") }
        let metadata: JSON = .object(["id": .string(photo.id), "mime": .string("image/jpeg"), "alt": .string(photo.alt),
                                      "width": .number(Double(photo.width)), "height": .number(Double(photo.height))])
        let envelope = try await vault.seal(metadata.replacing("bytes", with: .string(photo.bytes.base64EncodedString())), member: member,
                                            kind: "media", audience: audience, id: photo.id, group: group, parent: parent)
        let bytes = try JSONEncoder().encode(envelope)
        let upload = try await api.social("/media", method: "POST", body: .object(["id": .string(photo.id), "envelope": envelope, "byte_size": .number(Double(bytes.count))]))
        guard let path = upload["upload_url"].string else { throw PorchError.message("Photo upload was not authorized.") }
        _ = try await api.bytes(path, method: "PUT", body: bytes)
        return metadata
    }
    /// Explicit profile/group resharing creates a fresh asset for the new current audience.
    func reshareSurfacePhoto(_ metadata:JSON,audience:String,parent:String,group:String?=nil,parentExpiry:Date?=nil) async throws -> JSON {
        guard let member,let oldID=metadata["id"].string else{throw PorchError.message("A profile photo reference is missing.")}
        let raw=try await api.bytes("/api/v1/media/"+oldID+"/bytes"),oldEnvelope=try JSONDecoder().decode(JSON.self,from:raw)
        let payload=try await vault.open(.object(["id":.string(oldID),"envelope":oldEnvelope]))
        guard payload["mime"].string=="image/jpeg",let encoded=payload["bytes"].string,let bytes=Data(base64Encoded:encoded) else{throw PorchError.message("A profile photo could not be opened.")}
        _ = try PhotoPipeline.safelyDecode(bytes)
        let id=UUID().uuidString.lowercased(),expiry=[parentExpiry,oldEnvelope["context"]["expiresAt"].string.flatMap(PorchDate.parse)].compactMap{$0}.min()
        let envelope=try await vault.seal(payload.replacing("id",with:.string(id)),member:member,kind:"media",audience:audience,id:id,group:group,parent:parent,expiry:expiry)
        let packed=try JSONEncoder().encode(envelope),upload=try await api.social("/media",method:"POST",body:.object(["id":.string(id),"envelope":envelope,"byte_size":.number(Double(packed.count))]))
        guard let path=upload["upload_url"].string else{throw PorchError.message("A photo upload was not authorized.")}
        _ = try await api.bytes(path,method:"PUT",body:packed)
        return metadata.replacing("id",with:.string(id))
    }
}
