import SwiftUI

@main
struct CodexMiniApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var service = ServiceManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(service)
                .frame(width: 980, height: 650)
                .task {
                    await service.prepareIfNeeded()
                    await service.refresh()
                }
                .onChange(of: scenePhase) { phase in
                    if phase == .active { Task { await service.refresh() } }
                }
        }
        .defaultSize(width: 980, height: 650)
        .windowResizability(.contentSize)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("打开 \(service.appName) 网页") { service.openWeb() }
                    .keyboardShortcut("o", modifiers: [.command])
                Button("复制本机链接") { service.copyLocalLink() }
                    .keyboardShortcut("c", modifiers: [.command, .shift])
                Divider()
                Button("刷新状态") { Task { await service.refresh() } }
                    .keyboardShortcut("r", modifiers: [.command])
            }
        }
    }
}
