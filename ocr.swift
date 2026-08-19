// pilot-ocr — read text out of a screenshot locally, no API keys.
//
// Uses the macOS Vision framework (on-device). Prints recognized text lines
// to stdout, one per line, in reading order (top to bottom).
//
// Build:   swiftc -O ocr.swift -o ocr
// Usage:   ./ocr /path/to/image.png [--json]

import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write("usage: ocr <image> [--json]\n".data(using: .utf8)!)
    exit(2)
}
let path = CommandLine.arguments[1]
let wantJSON = CommandLine.arguments.contains("--json")

guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot load image: \(path)\n".data(using: .utf8)!)
    exit(2)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("vision failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}

let observations = request.results ?? []
if wantJSON {
    let items = observations.map { (obs: VNRecognizedTextObservation) -> [String: Any] in
        let candidate = obs.topCandidates(1).first
        let box = obs.boundingBox // normalized, origin bottom-left
        return [
            "text": candidate?.string ?? "",
            "confidence": candidate?.confidence ?? 0,
            "x": box.origin.x,
            "y": box.origin.y,
            "w": box.size.width,
            "h": box.size.height,
        ]
    }
    let data = try! JSONSerialization.data(withJSONObject: items, options: [.prettyPrinted])
    print(String(data: data, encoding: .utf8)!)
} else {
    for obs in observations {
        if let c = obs.topCandidates(1).first {
            print(c.string)
        }
    }
}
