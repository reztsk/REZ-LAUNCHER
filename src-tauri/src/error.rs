use serde::{Serialize, Serializer};

/// Unified error type returned by every Tauri command (serialized as a plain string).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Base de données : {0}")]
    Db(#[from] rusqlite::Error),
    #[error("E/S : {0}")]
    Io(#[from] std::io::Error),
    #[error("Jeu introuvable (id {0})")]
    GameNotFound(i64),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
