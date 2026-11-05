import SwiftUI

enum PhotoCalendar {
    // API day keys are Gregorian ISO dates even when the device displays a
    // different calendar (for example Buddhist years). Keep its local timezone.
    static var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = .current
        value.firstWeekday = Calendar.current.firstWeekday
        return value
    }
    static func day(_ date: Date, calendar: Calendar = PhotoCalendar.calendar) -> String {
        var iso = Calendar(identifier: .gregorian); iso.timeZone = calendar.timeZone
        let c = iso.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }
    static func month(_ date: Date, calendar: Calendar = PhotoCalendar.calendar) -> Date { calendar.date(from: calendar.dateComponents([.year, .month], from: date))! }
    static func cells(_ month: Date, calendar: Calendar = PhotoCalendar.calendar) -> [Date?] {
        let first = self.month(month, calendar: calendar)
        let offset = (calendar.component(.weekday, from: first) - calendar.firstWeekday + 7) % 7
        let days = calendar.range(of: .day, in: .month, for: first)!.count
        return (0..<((offset + days + 6) / 7 * 7)).map { index in index < offset || index >= offset + days ? nil : calendar.date(byAdding: .day, value: index - offset, to: first) }
    }
    static func filtered(_ items: [SocialItem], author: String, tag: String, now: Date = Date()) -> [SocialItem] {
        items.filter { item in
            (item.expiry.map { $0 > now } ?? true) && item.payload != nil &&
            (author.isEmpty || item.authorID == author) &&
            (tag.isEmpty || PersonTag.content(item.payload ?? .null).contains { $0.id == tag })
        }
    }
    static func featured(_ items: [SocialItem], choice: JSON) -> (SocialItem, JSON)? {
        guard let item = items.first(where: { $0.id == choice["post_id"].string }) ?? items.first(where: { !($0.payload?["media"].array ?? []).isEmpty }) ?? items.first else { return nil }
        let media = item.payload?["media"].array ?? []
        return (item, media.first(where: { $0["id"].string == choice["media_id"].string }) ?? media.first ?? .null)
    }
}
@MainActor final class CalendarStore: ObservableObject {
    @Published var entries: [String: [SocialItem]] = [:]
    @Published var highlights: [String: JSON] = [:]
    @Published var next: [String: JSON] = [:]
    @Published var busy: Set<String> = []
    @Published var errors: [String: String] = [:]
    func load(_ date: Date, model: AppModel, more: Bool = false) async {
        let month = PhotoCalendar.month(date), key = PhotoCalendar.day(month)
        guard !busy.contains(key), let member = model.member, model.vault.unlocked else { return }
        let generation = model.authenticationGeneration
        busy.insert(key); errors[key] = nil
        defer { busy.remove(key) }
        do {
            let end = PhotoCalendar.calendar.date(byAdding: .month, value: 1, to: month)!
            var query = URLComponents(); query.queryItems = [URLQueryItem(name: "start", value: PorchDate.string(month)), URLQueryItem(name: "end", value: PorchDate.string(end))]
            if more, let cursor = next[key] { query.queryItems! += [URLQueryItem(name: "after_at", value: cursor["at"].string), URLQueryItem(name: "after_id", value: cursor["id"].string)] }
            let result = try await model.api.social("/calendar?" + query.percentEncodedQuery!)
            var decoded: [SocialItem] = []
            for raw in result["items"].array { try Task.checkCancellation(); decoded.append(await model.vault.item(raw)) }
            let choices = try await model.api.social("/calendar/highlights?start=" + key + "&end=" + PhotoCalendar.day(end))
            guard model.member?.id == member.id, model.authenticationGeneration == generation, model.vault.unlocked, !Task.isCancelled else { return }
            let old = more ? entries[key] ?? [] : []
            entries[key] = old + decoded.filter { item in !old.contains { $0.id == item.id } }
            next[key] = result["next"] == .null ? nil : result["next"]
            let endKey = PhotoCalendar.day(end)
            highlights = highlights.filter { $0.key < key || $0.key >= endKey }
            for row in choices["items"].array { if let day = row["day"].string { highlights[day] = row } }
            let unreadable = decoded.filter { $0.payload == nil }.count
            if unreadable > 0 { errors[key] = "\(unreadable) posts could not be decrypted on this device." }
        } catch { if !(error is CancellationError) { errors[key] = error.localizedDescription } }
    }
    func choose(_ date: Date, item: SocialItem?, media: JSON = .null, model: AppModel) async {
        let day = PhotoCalendar.day(date), generation = model.authenticationGeneration
        await model.perform {
            let choice: JSON = .object(["post_id": item.map { .string($0.id) } ?? .null, "media_id": media["id"]])
            _ = try await model.api.social("/calendar/highlights/" + day, method: item == nil ? "DELETE" : "PUT", body: item == nil ? nil : choice)
            guard model.authenticationGeneration == generation else { return }
            highlights[day] = item == nil ? nil : choice
        }
    }
}
struct PhotosCalendarView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var store = CalendarStore()
    @StateObject private var directory = PeopleDirectory()
    @State private var months = 1
    @State private var author = ""
    @State private var tag = ""
    @State private var selected: Date?
    @State private var initialized = false
    private let current = PhotoCalendar.month(Date())
    var body: some View {
        VStack {
            HStack {
                Picker("Posted by", selection: $author) { Text("Everyone").tag(""); ForEach(directory.people.filter { $0.kind == "member" }) { Text("@" + $0.label).tag($0.personID) } }
                Picker("Tagged", selection: $tag) { Text("Anyone").tag(""); ForEach(directory.people) { Text($0.label).tag($0.id) } }
            }.padding(.horizontal)
            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(spacing: 24) {
                        Button("Load earlier month") { earlier(reader) }.onAppear { if initialized { earlier(reader) } }
                        ForEach(Array((0..<months).reversed()), id: \.self) { offset in
                            let month = PhotoCalendar.calendar.date(byAdding: .month, value: -offset, to: current)!
                            CalendarMonthView(month: month, store: store, author: author, tag: tag) { selected = $0 }.id(PhotoCalendar.day(month))
                        }
                    }.padding()
                }.refreshable { await store.load(current, model: model) }
                .task { if !initialized { reader.scrollTo(PhotoCalendar.day(current), anchor: .top); initialized = true } }
            }
        }.navigationTitle("Photos").task { await directory.load(model); await store.load(current, model: model) }
        .sheet(isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })) {
            if let selected { NavigationStack { CalendarDayView(initial: selected, store: store, author: author, tag: tag) } }
        }
    }
    private func earlier(_ reader: ScrollViewProxy) {
        let anchor = PhotoCalendar.day(PhotoCalendar.calendar.date(byAdding: .month, value: -(months - 1), to: current)!)
        months += 1
        DispatchQueue.main.async { reader.scrollTo(anchor, anchor: .top) }
    }
}
struct CalendarMonthView: View {
    let month: Date
    @ObservedObject var store: CalendarStore
    let author: String
    let tag: String
    let select: (Date) -> Void
    @EnvironmentObject var model: AppModel
    private var key: String { PhotoCalendar.day(month) }
    var body: some View {
        VStack {
            Text(month.formatted(.dateTime.month(.wide).year())).font(.title2.bold())
            TimelineView(.periodic(from: .now, by: 1)) { clock in
                let items = PhotoCalendar.filtered(store.entries[key] ?? [], author: author, tag: tag, now: clock.date)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 7), spacing: 2) {
                    ForEach(Array(PhotoCalendar.cells(month).enumerated()), id: \.offset) { _, date in
                        if let date {
                            let day = PhotoCalendar.day(date)
                            let rows = items.filter { $0.created.map { PhotoCalendar.day($0) } == day }
                            Button { select(date) } label: {
                                ZStack(alignment: .topLeading) {
                                    Rectangle().fill(.quaternary)
                                    if let chosen = PhotoCalendar.featured(rows, choice: store.highlights[day] ?? .null) {
                                        if chosen.1 != .null { EncryptedMediaView(media: chosen.1, thumbnail: true) }
                                        else { Text(chosen.0.text).font(.caption2).lineLimit(4).padding(.top, 20) }
                                    }
                                    Text("\(PhotoCalendar.calendar.component(.day, from: date))").font(.caption.bold()).padding(3).background(.regularMaterial)
                                }.frame(height: 86).clipped()
                            }.buttonStyle(.plain).accessibilityLabel(date.formatted(date: .complete, time: .omitted) + ", \(rows.count) posts")
                        } else { Color.clear.frame(height: 86) }
                    }
                }
            }
            if store.busy.contains(key) { ProgressView("Opening month…") }
            if let error = store.errors[key] { Text(error).foregroundStyle(.red); Button("Retry month") { Task { await store.load(month, model: model) } } }
            Button("Refresh month") { Task { await store.load(month, model: model) } }.disabled(store.busy.contains(key))
            if store.next[key] != nil { Button("Load more posts in this month") { Task { await store.load(month, model: model, more: true) } } }
        }.task { if store.entries[key] == nil { await store.load(month, model: model) } }
    }
}
struct CalendarDayView: View {
    let initial: Date
    @ObservedObject var store: CalendarStore
    let author: String
    let tag: String
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var date: Date?
    private var current: Date { date ?? initial }
    private var monthKey: String { PhotoCalendar.day(PhotoCalendar.month(current)) }
    var body: some View {
        VStack {
            HStack { Button("Previous day", systemImage: "chevron.left") { move(-1) }; Spacer(); Text(current.formatted(date: .abbreviated, time: .omitted)); Spacer(); Button("Next day", systemImage: "chevron.right") { move(1) } }.padding()
            TimelineView(.periodic(from: .now, by: 1)) { clock in
            List {
                let rows = PhotoCalendar.filtered(store.entries[monthKey] ?? [], author: author, tag: tag, now: clock.date).filter { $0.created.map { PhotoCalendar.day($0) } == PhotoCalendar.day(current) }
                ForEach(rows) { item in
                    NavigationLink { PostDetailView(id: item.id) } label: { MomentCard(item: item) }
                    Button("Feature this post") { Task { await store.choose(current, item: item, model: model) } }
                    ForEach(Array((item.payload?["media"].array ?? []).enumerated()), id: \.offset) { index, media in
                        Button("Feature attachment \(index + 1)") { Task { await store.choose(current, item: item, media: media, model: model) } }
                    }
                }
                if rows.isEmpty { Text(store.busy.contains(monthKey) ? "Opening this day…" : "No matching posts loaded for this day.") }
                if let error = store.errors[monthKey] { Text(error).foregroundStyle(.red) }
                if store.next[monthKey] != nil { Button("Load more posts") { Task { await store.load(current, model: model, more: true) } } }
                Button("Use automatic highlight") { Task { await store.choose(current, item: nil, model: model) } }
            }.simultaneousGesture(DragGesture(minimumDistance: 60).onEnded { value in
                if abs(value.translation.width) > abs(value.translation.height) * 1.5 { move(value.translation.width < 0 ? 1 : -1) }
            })
            }
        }.navigationTitle("Day").toolbar { Button("Done") { dismiss() } }
        .task(id: monthKey) { if store.entries[monthKey] == nil { await store.load(current, model: model) } }
    }
    private func move(_ offset: Int) { date = PhotoCalendar.calendar.date(byAdding: .day, value: offset, to: current) }
}
