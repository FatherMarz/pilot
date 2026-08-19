// make-icons.swift — render the Pilot icon set (16/32/48/128) as PNGs.
// Usage: swift make-icons.swift
import AppKit

let outputDir = "extension/icons"
try! FileManager.default.createDirectory(atPath: outputDir, withIntermediateDirectories: true)

// A rounded square, sand/ink gradient, with a paper-plane mark.
func drawIcon(size: Int) -> NSImage {
    let s = CGFloat(size)
    let img = NSImage(size: NSSize(width: s, height: s))
    img.lockFocus()

    // Rounded rect background.
    let bg = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: s, height: s), xRadius: s * 0.22, yRadius: s * 0.22)
    let grad = NSGradient(colors: [
        NSColor(calibratedRed: 0.08, green: 0.10, blue: 0.12, alpha: 1),   // ink
        NSColor(calibratedRed: 0.13, green: 0.16, blue: 0.14, alpha: 1),
    ])!
    grad.draw(in: bg, angle: -90)

    // Paper plane: teal body + sand wing.
    let plane = NSBezierPath()
    let cx = s * 0.5
    let cy = s * 0.52
    plane.move(to: NSPoint(x: cx - s * 0.30, y: cy + s * 0.18))
    plane.line(to: NSPoint(x: cx + s * 0.28, y: cy + s * 0.30))
    plane.line(to: NSPoint(x: cx + s * 0.06, y: cy))
    plane.line(to: NSPoint(x: cx + s * 0.30, y: cy - s * 0.26))
    plane.line(to: NSPoint(x: cx - s * 0.12, y: cy + s * 0.10))
    plane.line(to: NSPoint(x: cx - s * 0.30, y: cy - s * 0.06))
    plane.close()

    let teal = NSColor(calibratedRed: 0.0, green: 0.639, blue: 0.639, alpha: 1)
    teal.setFill()
    plane.fill()

    // Sand accent dot (like a status light).
    let dot = NSBezierPath(ovalIn: NSRect(x: cx + s * 0.30, y: cy - s * 0.36, width: s * 0.16, height: s * 0.16))
    NSColor(calibratedRed: 0.88, green: 0.83, blue: 0.70, alpha: 1).setFill()
    dot.fill()

    img.unlockFocus()
    return img
}

for size in [16, 32, 48, 128] {
    let img = drawIcon(size: size)
    let tiff = img.tiffRepresentation!
    let rep = NSBitmapImageRep(data: tiff)!
    let png = rep.representation(using: .png, properties: [:])!
    let path = "\(outputDir)/icon\(size).png"
    try! png.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)")
}
