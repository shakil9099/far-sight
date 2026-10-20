fn main() {
    // Native macOS layer (mic/video detection, idle, lock, window levels).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=native/macos.m");
        cc::Build::new().file("native/macos.m").flag("-fobjc-arc").flag("-mmacosx-version-min=11.0").compile("farsight_native");
        for fw in ["AppKit", "CoreAudio", "CoreGraphics", "IOKit", "CoreFoundation", "WebKit"] {
            println!("cargo:rustc-link-lib=framework={fw}");
        }
    }
    tauri_build::build();
}
