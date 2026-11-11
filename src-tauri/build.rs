use std::process::Command;

fn output(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd).args(args).output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default().trim().to_string()
}

fn main() {
    // Every build's version is major.minor from Cargo.toml and the commit count as the patch number, as in 0.2.17;
    // scripts/version.sh counts the same way for the bundles and the git tags.
    let build = output("git", &["rev-list", "--count", "HEAD"]);
    let base = format!("{}.{}", std::env::var("CARGO_PKG_VERSION_MAJOR").unwrap(), std::env::var("CARGO_PKG_VERSION_MINOR").unwrap());
    let patch = if build.is_empty() { std::env::var("CARGO_PKG_VERSION_PATCH").unwrap() } else { build.clone() };
    println!("cargo:rustc-env=TRELLIS_VERSION={base}.{patch}");
    println!("cargo:rustc-env=TRELLIS_BUILD={build}");
    println!("cargo:rustc-env=TRELLIS_BUILT={}", output("date", &["+%Y-%m-%d"]));
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads");
    tauri_build::build()
}
