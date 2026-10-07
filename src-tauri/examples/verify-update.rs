//! CI-only verification using the same Minisign library as the Tauri updater.
//! Reads only public configuration, installer and signature; never private keys.
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use std::{error::Error, fs};

fn verify(installer: &[u8], signature: &str, public_key: &str, version: &str) -> Result<(), Box<dyn Error>> {
    let decode = |value: &str| -> Result<String, Box<dyn Error>> {
        Ok(String::from_utf8(base64::engine::general_purpose::STANDARD.decode(value.trim())?)?)
    };
    let key = PublicKey::decode(&decode(public_key)?)?;
    let signature = Signature::decode(&decode(signature)?)?;
    key.verify(installer, &signature, false)?;
    let versions: Vec<_> = signature.trusted_comment().split('\t')
        .filter_map(|field| field.strip_prefix("version:")).collect();
    if versions != [version] { return Err("Signature must bind exactly the published version".into()); }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 4 { return Err("Usage: verify-update <installer> <signature> <public-config> <version>".into()); }
    let config: serde_json::Value = serde_json::from_slice(&fs::read(&args[2])?)?;
    let public_key = config["plugins"]["updater"]["pubkey"].as_str().ok_or("Missing updater public key")?;
    verify(&fs::read(&args[0])?, &fs::read_to_string(&args[1])?, public_key, &args[3])?;
    println!("Installer signature and version verified against configured public key.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_missing_or_invalid_signatures() {
        for signature in ["", "not-a-signature"] {
            assert!(verify(b"installer", signature, "not-a-public-key", "0.1.0").is_err());
        }
    }
}
