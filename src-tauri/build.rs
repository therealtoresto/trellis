use std::process::Command;

fn output(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd).args(args).output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default().trim().to_string()
}

fn main() {
    // The welcome window shows a build number, counted from the commits, as in "Version 0.2.0 (4)".
    println!("cargo:rustc-env=TRELLIS_BUILD={}", output("git", &["rev-list", "--count", "HEAD"]));
    println!("cargo:rustc-env=TRELLIS_BUILT={}", output("date", &["+%Y-%m-%d"]));
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads");
    tauri_build::build()
}
