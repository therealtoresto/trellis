//! SSH tunnels, as `ssh -L` makes them: a port on 127.0.0.1 forwards each connection through the SSH server to the
//! database host and port as that server sees them. The server's key is checked against ~/.ssh/known_hosts and then
//! Trellis' own list; a host met for the first time is trusted and remembered there, as `ssh` does with accept-new.

use super::{err, Config, R};
use russh::client;
use russh::keys::{self, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;

/// An open tunnel; dropping it stops forwarding and closes the SSH connection.
pub struct Tunnel {
    pub port: u16,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Client {
    host: String,
    port: u16,
    known: PathBuf,
    /// Why the server was turned away, for a clearer message than the library's.
    problem: Arc<Mutex<Option<String>>>,
}

fn home() -> PathBuf {
    super::home_dir()
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            *self.problem.lock().unwrap() = Some("The SSH server offered a certificate; Trellis checks plain host keys only.".into());
            return Ok(false);
        };
        for path in [home().join(".ssh").join("known_hosts"), self.known.clone()] {
            match keys::check_known_hosts_path(&self.host, self.port, key, &path) {
                Ok(true) => return Ok(true),
                Err(keys::Error::KeyChanged { line }) => {
                    *self.problem.lock().unwrap() = Some(format!(
                        "The SSH host key of {} has changed (see line {line} of {}). If the server was rebuilt, remove that line and connect again.",
                        self.host,
                        path.display()
                    ));
                    return Ok(false);
                }
                _ => {}
            }
        }
        if let Some(dir) = self.known.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = keys::known_hosts::learn_known_hosts_path(&self.host, self.port, key, &self.known);
        Ok(true)
    }
}

/// `~/x` and `~` mean the home folder, as in ssh's own settings.
fn expand(path: &str) -> PathBuf {
    match path.strip_prefix("~") {
        Some(rest) => home().join(rest.trim_start_matches('/')),
        None => PathBuf::from(path),
    }
}

async fn with_key(session: &mut client::Handle<Client>, user: &str, path: &PathBuf, passphrase: Option<&str>) -> R<bool> {
    let key = keys::load_secret_key(path, passphrase).map_err(|e| match e {
        keys::Error::KeyIsEncrypted => format!("The SSH key {} needs its passphrase.", path.display()),
        e => format!("Could not read the SSH key {}: {e}", path.display()),
    })?;
    let hash = session.best_supported_rsa_hash().await.map_err(err)?.flatten();
    Ok(session.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await.map_err(err)?.success())
}

/// Signs in with each key an SSH agent holds until one is accepted.
async fn agent_keys<R>(session: &mut client::Handle<Client>, user: &str, mut agent: keys::agent::client::AgentClient<R>) -> bool
where
    R: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let Ok(ids) = agent.request_identities().await else { return false };
    for id in ids {
        let key = id.public_key().into_owned();
        let hash = session.best_supported_rsa_hash().await.ok().flatten().flatten();
        if let Ok(r) = session.authenticate_publickey_with(user, key, hash, &mut agent).await {
            if r.success() {
                return true;
            }
        }
    }
    false
}

/// The agent SSH_AUTH_SOCK names.
#[cfg(unix)]
async fn with_agent(session: &mut client::Handle<Client>, user: &str) -> bool {
    match keys::agent::client::AgentClient::connect_env().await {
        Ok(agent) => agent_keys(session, user, agent).await,
        Err(_) => false,
    }
}

/// Windows' own OpenSSH agent, then Pageant (PuTTY's).
#[cfg(windows)]
async fn with_agent(session: &mut client::Handle<Client>, user: &str) -> bool {
    use keys::agent::client::AgentClient;
    if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        if agent_keys(session, user, agent).await {
            return true;
        }
    }
    match AgentClient::connect_pageant().await {
        Ok(agent) => agent_keys(session, user, agent).await,
        Err(_) => false,
    }
}

/// Opens the SSH connection, signs in and starts forwarding to the database `cfg` names. `default_port` is the
/// engine's, for a connection without one. `known` is Trellis' own known-hosts file.
pub async fn open(cfg: &Config, default_port: u16, known: PathBuf) -> R<Tunnel> {
    let host = Config::text(&cfg.ssh_host).ok_or("Enter the SSH host.")?.to_string();
    let port = cfg.ssh_port.as_ref().and_then(|p| match p {
        serde_json::Value::Number(n) => n.as_u64(),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }).map(|p| p as u16).unwrap_or(22);
    let user = Config::text(&cfg.ssh_user).map(String::from).or_else(|| std::env::var("USER").or_else(|_| std::env::var("USERNAME")).ok()).ok_or("Enter the SSH user.")?;
    let target = (Config::text(&cfg.host).unwrap_or("127.0.0.1").to_string(), cfg.port(default_port));

    let config = Arc::new(client::Config { keepalive_interval: Some(Duration::from_secs(30)), ..Default::default() });
    let problem = Arc::new(Mutex::new(None));
    let handler = Client { host: host.clone(), port, known, problem: problem.clone() };
    let mut session = match tokio::time::timeout(Duration::from_secs(10), client::connect(config, (host.as_str(), port), handler)).await {
        Err(_) => return Err(format!("The SSH server {host}:{port} did not answer within 10 seconds.")),
        Ok(Err(e)) => return Err(problem.lock().unwrap().take().unwrap_or_else(|| format!("SSH {host}:{port}: {e}"))),
        Ok(Ok(s)) => s,
    };

    let secret = cfg.ssh_password.as_deref().filter(|p| !p.is_empty());
    let signed_in = match cfg.ssh_auth.as_deref().unwrap_or("auto") {
        "password" => session.authenticate_password(&user, secret.unwrap_or_default()).await.map_err(err)?.success(),
        "key" => {
            let path = Config::text(&cfg.ssh_key).map(expand).ok_or("Choose the SSH key file.")?;
            with_key(&mut session, &user, &path, secret).await?
        }
        // The agent's keys, then the usual key files.
        _ => {
            let mut ok = with_agent(&mut session, &user).await;
            for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
                let path = home().join(".ssh").join(name);
                if ok || !path.exists() {
                    continue;
                }
                ok = with_key(&mut session, &user, &path, secret).await.unwrap_or(false);
            }
            ok
        }
    };
    if !signed_in {
        return Err(format!("The SSH server {host} did not accept {user}'s {}.", match cfg.ssh_auth.as_deref() {
            Some("password") => "password",
            Some("key") => "key",
            _ => "keys from the SSH agent or ~/.ssh",
        }));
    }

    // One channel up front tells whether the SSH server can reach the database at all.
    let probe = session
        .channel_open_direct_tcpip(target.0.clone(), target.1 as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| format!("Signed in to {host}, but it could not reach {}:{} ({e}).", target.0, target.1))?;
    let _ = probe.close().await;

    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(err)?;
    let local = listener.local_addr().map_err(err)?.port();
    let session = Arc::new(session);
    let task = tokio::spawn(async move {
        while let Ok((mut sock, peer)) = listener.accept().await {
            let (s, (h, p)) = (session.clone(), target.clone());
            tokio::spawn(async move {
                if let Ok(ch) = s.channel_open_direct_tcpip(h, p as u32, peer.ip().to_string(), peer.port() as u32).await {
                    let mut stream = ch.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                }
            });
        }
    });
    Ok(Tunnel { port: local, task })
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::server::{self, Auth};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A test SSH server: password `pw` for user `u`, and forwarding to wherever the client asks.
    #[derive(Clone)]
    struct Server;

    impl server::Handler for Server {
        type Error = russh::Error;

        async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
            Ok(if user == "u" && password == "pw" { Auth::Accept } else { Auth::reject() })
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: russh::Channel<server::Msg>,
            host: &str,
            port: u32,
            _: &str,
            _: u32,
            reply: server::ChannelOpenHandle,
            _: &mut server::Session,
        ) -> Result<(), Self::Error> {
            // Like sshd: reach the target first, then accept the channel or refuse it.
            let Ok(mut sock) = tokio::net::TcpStream::connect(format!("{host}:{port}")).await else {
                reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
                return Ok(());
            };
            reply.accept().await;
            tokio::spawn(async move {
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut sock).await;
            });
            Ok(())
        }
    }

    fn host_key(seed: u8) -> keys::PrivateKey {
        keys::PrivateKey::from(keys::ssh_key::private::Ed25519Keypair::from_seed(&[seed; 32]))
    }

    async fn ssh_server(seed: u8) -> u16 {
        let config = Arc::new(server::Config { keys: vec![host_key(seed)], ..Default::default() });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let c = config.clone();
                tokio::spawn(async move {
                    if let Ok(s) = server::run_stream(c, sock, Server).await {
                        let _ = s.await;
                    }
                });
            }
        });
        port
    }

    async fn echo_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let (mut r, mut w) = sock.split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
            }
        });
        port
    }

    fn cfg(ssh_port: u16, target: u16, password: &str) -> Config {
        Config {
            engine: "postgres".into(),
            host: Some("127.0.0.1".into()),
            port: Some(json!(target)),
            ssh: Some(true),
            ssh_host: Some("127.0.0.1".into()),
            ssh_port: Some(json!(ssh_port)),
            ssh_user: Some("u".into()),
            ssh_auth: Some("password".into()),
            ssh_password: Some(password.into()),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn tunnel_forwards_and_checks_the_host() {
        let dir = std::env::temp_dir().join(format!("trellis-ssh-{}", std::process::id()));
        let known = dir.join("known_hosts");
        let _ = std::fs::remove_file(&known);
        let (ssh, echo) = (ssh_server(1).await, echo_server().await);

        // Bytes go through the tunnel and come back.
        let t = open(&cfg(ssh, echo, "pw"), 5432, known.clone()).await.unwrap();
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", t.port)).await.unwrap();
        s.write_all(b"hello trellis").await.unwrap();
        let mut buf = [0u8; 13];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello trellis");
        // The host was remembered on first sight.
        assert!(std::fs::read_to_string(&known).unwrap().contains(&format!("[127.0.0.1]:{ssh}")));
        drop(t);

        // A wrong password says so.
        let e = open(&cfg(ssh, echo, "nope"), 5432, known.clone()).await.err().unwrap();
        assert!(e.contains("did not accept u's password"), "{e}");

        // A server whose key changed is refused.
        let other = ssh_server(2).await;
        keys::known_hosts::learn_known_hosts_path("127.0.0.1", other, host_key(1).public_key(), &known).unwrap();
        let e = open(&cfg(other, echo, "pw"), 5432, known.clone()).await.err().unwrap();
        assert!(e.contains("host key of 127.0.0.1 has changed"), "{e}");

        // An unreachable database is reported after signing in.
        let e = open(&cfg(ssh, 1, "pw"), 5432, known.clone()).await.err().unwrap();
        assert!(e.contains("could not reach 127.0.0.1:1"), "{e}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
