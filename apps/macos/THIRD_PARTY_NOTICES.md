# Peekaboo

`Sources/SageAppShot/AXReadPolicy.swift` adapts the attribute read completeness policy from
`openclaw/Peekaboo`, commit `016240d908566e54b702336ba39abc0f621b5b60`, file
`Core/PeekabooAutomationKit/Sources/PeekabooAutomationKit/Services/UI/AXDescriptorReader.swift`.
The unused AXorcist import was replaced with ApplicationServices. The Swift package builds this
policy independently, without Peekaboo's automation, agent runtime or CLI.

The screenshot capture, window matching and bounded text traversal in Sage are native implementations;
this is not a vendored copy of the complete Peekaboo capture engine.

MIT License

Copyright (c) 2025 Peter Steinberger

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# Node.js

The local app bundle includes the Node.js executable used only by the existing Codex/materials
protocol bridge. Its distribution license and bundled third-party notices are copied verbatim
to `Contents/Resources/Node-LICENSE.txt` during packaging.
