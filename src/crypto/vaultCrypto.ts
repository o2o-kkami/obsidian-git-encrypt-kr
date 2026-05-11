/**
 * Transparent vault encryption layer for obsidian-git-encrypt-kr.
 *
 * Provides AES-256-GCM encryption with a deterministic IV derived from the
 * plaintext via HMAC-SHA256. Deterministic IV ensures that the same plaintext
 * always produces the same ciphertext, which is required for git's
 * content-addressable storage to not see spurious changes on every push.
 *
 * Threat model: protects vault contents at rest on the remote git server
 * (and anywhere else the encrypted bytes flow). Keys never leave the device.
 *
 * Key derivation: PBKDF2(password, FIXED_SALT, 200_000 iter, SHA-256) → 64 bytes.
 * The salt is a hardcoded plugin constant rather than per-vault state, so
 * users never have to coordinate or worry about a config file. The
 * iteration count is the primary defense against offline brute-force.
 *
 * Format:
 *   [9 bytes magic "OBSCRYPT\x01"][12 bytes IV][ciphertext + 16 byte GCM tag]
 */

// "OBSCRYPT" + version byte 0x01
export const MAGIC = new Uint8Array([
    0x4f, 0x42, 0x53, 0x43, 0x52, 0x59, 0x50, 0x54, 0x01,
]);
export const MAGIC_LEN = MAGIC.length;
export const IV_LEN = 12;
export const PBKDF2_ITERATIONS = 200_000;

/* ==========================================================================
 *  ⚠️  DO NOT MODIFY THE STRING BELOW. EVER.  ⚠️
 *  ⚠️  아래 문자열은 절대 수정하지 마세요. 영구 데이터 손실로 이어집니다. ⚠️
 * ==========================================================================
 *
 * `FIXED_SALT_INPUT` is the literal byte sequence fed into PBKDF2 as the
 * salt for deriving the AES-256 / HMAC-SHA256 keys from the user's
 * password. The hash of this string IS the salt; changing the string
 * changes the salt; changing the salt changes every derived key.
 *
 *   👉  This value is a STABLE CRYPTOGRAPHIC IDENTIFIER, intentionally
 *       DECOUPLED from the plugin's manifest `id`. It only LOOKS like
 *       the old plugin id because that's what it was named when the
 *       scheme was first published. Treat it as an opaque magic
 *       constant — a UUID that happens to be human-readable.
 *
 * Changing this string in ANY way — including all of these tempting
 * "harmless" edits:
 *   • renaming it to match a rebranded plugin id
 *   • find-and-replace across the repo for the old plugin name
 *   • "cleaning up" the colon-separated format
 *   • bumping `:v1` to `:v2` thinking it is just versioning
 *   • removing the trailing version suffix
 *   • normalising whitespace / case
 *
 * ...will make EVERY file that any user has ever encrypted with this
 * plugin PERMANENTLY UNDECRYPTABLE. There is no recovery path. The
 * only mitigation after such a change ships is: every user must still
 * have plaintext copies of their old vault somewhere, and re-encrypt
 * from scratch under the new salt.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  한국어 요약
 * ──────────────────────────────────────────────────────────────────────
 *  이 문자열은 PBKDF2 키 도출용 "고정 salt"의 입력값입니다.
 *  plugin id / 리포 이름 / 폴더 이름과는 완전히 별개의 식별자이며,
 *  과거 plugin id와 우연히 같은 문자열일 뿐입니다.
 *
 *  이 문자열을 어떤 방식으로든 (rename, refactor, 버전 숫자 변경,
 *  공백/대소문자 정리 등) 변경하면 — 모든 사용자의 기존 암호화 파일이
 *  영구적으로 복호화 불가능해집니다. 복구 방법은 없습니다.
 *
 *  Plugin id를 바꾸더라도 이 상수는 절대 함께 바꾸지 마세요.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  Design rationale (참고용)
 * ──────────────────────────────────────────────────────────────────────
 *  - PBKDF2 salt is not secret; its only job is to defeat generic
 *    precomputed rainbow tables. A single fixed plugin-specific salt
 *    achieves that for our threat model (small private deployments)
 *    about as well as a per-vault random salt would.
 *  - A fixed salt eliminates the cross-device coordination problem
 *    that a per-vault salt creates (salt file getting gitignored,
 *    accidentally deleted, lost on device wipe, etc.).
 *
 *  If a genuine cryptographic concern is ever discovered and the salt
 *  MUST be rotated, the correct procedure is:
 *    1. Bump `:v1` → `:v2` (introducing a NEW constant, not editing
 *       this one).
 *    2. Ship a migration that, while the user still has access to
 *       data under the v1-derived key, decrypts under v1 and
 *       re-encrypts under v2 in a single atomic operation per file.
 *    3. Only after every user has successfully migrated, retire v1.
 *  Do NOT just change this string and ship.
 * ==========================================================================
 */
const FIXED_SALT_INPUT = "obsidian-git-encrypted:fixed-salt:v1";
let cachedFixedSalt: Uint8Array | undefined;

async function getFixedSalt(): Promise<Uint8Array> {
    if (cachedFixedSalt) return cachedFixedSalt;
    const hashBuf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(FIXED_SALT_INPUT)
    );
    cachedFixedSalt = new Uint8Array(hashBuf);
    return cachedFixedSalt;
}

export interface VaultKeys {
    /** AES-256-GCM key for encrypt/decrypt. */
    aesKey: CryptoKey;
    /** HMAC-SHA256 key for deterministic IV derivation. */
    hmacKey: CryptoKey;
}

/**
 * Derive both an AES-256 key and an HMAC-SHA256 key from the user's
 * password via PBKDF2 with a fixed plugin-internal salt. 64 bytes are
 * derived; first 32 → AES, next 32 → HMAC.
 *
 * Same password on every device deterministically produces the same keys,
 * so no cross-device state has to be synchronized.
 */
export async function deriveKeys(password: string): Promise<VaultKeys> {
    const salt = await getFixedSalt();

    const passwordKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: salt as BufferSource,
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256",
        },
        passwordKey,
        512 // 64 bytes
    );

    const aesKeyBytes = bits.slice(0, 32);
    const hmacKeyBytes = bits.slice(32, 64);

    const aesKey = await crypto.subtle.importKey(
        "raw",
        aesKeyBytes,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );

    const hmacKey = await crypto.subtle.importKey(
        "raw",
        hmacKeyBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    return { aesKey, hmacKey };
}

/**
 * Encrypt plaintext with the given keys. The IV is derived deterministically
 * from the plaintext, so encrypting the same plaintext twice yields identical
 * ciphertext — this is required for stable git object hashes.
 */
export async function encrypt(
    plaintext: Uint8Array,
    keys: VaultKeys
): Promise<Uint8Array> {
    const ivFull = await crypto.subtle.sign(
        "HMAC",
        keys.hmacKey,
        plaintext as BufferSource
    );
    const iv = new Uint8Array(ivFull).slice(0, IV_LEN);

    const ctBuffer = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        keys.aesKey,
        plaintext as BufferSource
    );
    const ct = new Uint8Array(ctBuffer);

    const out = new Uint8Array(MAGIC_LEN + IV_LEN + ct.length);
    out.set(MAGIC, 0);
    out.set(iv, MAGIC_LEN);
    out.set(ct, MAGIC_LEN + IV_LEN);
    return out;
}

/**
 * Decrypt a previously-encrypted buffer. Throws if the magic header is
 * missing or the GCM authentication tag does not verify (tampered data).
 */
export async function decrypt(
    encrypted: Uint8Array,
    keys: VaultKeys
): Promise<Uint8Array> {
    if (!isEncrypted(encrypted)) {
        throw new Error(
            "복호화 실패: 데이터에 암호화 매직 헤더(OBSCRYPT)가 없습니다"
        );
    }
    if (encrypted.length < MAGIC_LEN + IV_LEN + 16) {
        throw new Error(
            "복호화 실패: GCM 인증 태그를 포함하기에 데이터가 너무 짧습니다"
        );
    }

    const iv = encrypted.slice(MAGIC_LEN, MAGIC_LEN + IV_LEN);
    const ct = encrypted.slice(MAGIC_LEN + IV_LEN);

    const ptBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        keys.aesKey,
        ct as BufferSource
    );
    return new Uint8Array(ptBuffer);
}

/** True iff the buffer starts with the OBSCRYPT magic header. */
export function isEncrypted(data: Uint8Array): boolean {
    if (data.length < MAGIC_LEN) return false;
    for (let i = 0; i < MAGIC_LEN; i++) {
        if (data[i] !== MAGIC[i]) return false;
    }
    return true;
}

// (No per-vault salt management — see {@link getFixedSalt} above for why.)
