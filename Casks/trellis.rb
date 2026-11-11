cask "trellis" do
  # brew tap therealtoresto/trellis https://github.com/therealtoresto/trellis && brew trust therealtoresto/trellis
  # Always the newest release; Trellis updates itself after that (Trellis → Check for Updates…).
  version :latest
  sha256 :no_check

  url "https://github.com/therealtoresto/trellis/releases/latest/download/Trellis_macos_arm64.zip",
      verified: "github.com/therealtoresto/trellis/"
  name "Trellis"
  desc "Database client for SQLite, PostgreSQL and MySQL"
  homepage "https://github.com/therealtoresto/trellis"

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: ">= :big_sur"

  app "Trellis.app"

  # The app is not signed by Apple; without this, the first launch stops at the Gatekeeper prompt.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Trellis.app"]
  end

  zap trash: [
    "~/Library/Application Support/com.tarasbondaruk.trellis",
    "~/Library/Caches/com.tarasbondaruk.trellis",
    "~/Library/WebKit/com.tarasbondaruk.trellis",
  ]
end
