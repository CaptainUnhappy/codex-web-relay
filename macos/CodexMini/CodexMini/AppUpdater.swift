import Foundation

@MainActor
final class AppUpdater: ObservableObject {
    @Published var canCheckForUpdates = false
    func checkForUpdates() {}
    func checkForUpdatesOnLaunchIfNeeded() {}
}
