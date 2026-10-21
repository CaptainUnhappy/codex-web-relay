import Foundation
import CoreGraphics

let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []

struct Candidate {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    var area: Double { width * height }
}

var candidates: [Candidate] = []

for window in windows {
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    let layer = window[kCGWindowLayer as String] as? Int ?? -1
    guard owner == "Codex", layer == 0 else { continue }
    guard let bounds = window[kCGWindowBounds as String] as? [String: Any] else { continue }
    let x = bounds["X"] as? Double ?? 0
    let y = bounds["Y"] as? Double ?? 0
    let width = bounds["Width"] as? Double ?? 0
    let height = bounds["Height"] as? Double ?? 0
    guard width > 500, height > 500 else { continue }
    candidates.append(Candidate(x: x, y: y, width: width, height: height))
}

guard let best = candidates.max(by: { $0.area < $1.area }) else {
    fputs("No visible Codex main window found\n", stderr)
    exit(2)
}

let clickX = Int((best.x + best.width / 2).rounded())
let clickY = Int((best.y + best.height - 88).rounded())
print("\(clickX),\(clickY)")
