/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/require-await */
// Mirror MyAdapter's eslint disables — this class extends it and inherits
// the same `promises: any` plumbing into isomorphic-git, so the same
// trade-offs apply.
/**
 * EncryptedAdapter — transparent encryption layer between isomorphic-git
 * and the vault filesystem.
 *
 * Sits on top of MyAdapter. For paths inside the .git directory the calls
 * pass through unchanged (those are git's own internal storage and must not
 * be touched). For paths in the vault (notes, attachments, etc.) the
 * content is encrypted on the way OUT to git (readFile) and decrypted on
 * the way IN from git (writeFile).
 *
 * Net effect:
 *   - Obsidian itself reads/writes the vault via vault.read()/modify(),
 *     which never touches this adapter, so search/graph/backlinks work on
 *     plaintext as usual.
 *   - isomorphic-git only ever sees encrypted bytes — what it stores in
 *     .git/objects and pushes to the remote is ciphertext.
 */
import type { Vault } from "obsidian";
import type ObsidianGit from "../main";
import { MyAdapter } from "./myAdapter";
import {
    decrypt,
    encrypt,
    isEncrypted,
    type VaultKeys,
} from "../crypto/vaultCrypto";

export class EncryptedAdapter extends MyAdapter {
    private keys: VaultKeys | undefined;
    private readonly pluginRef: ObsidianGit;

    constructor(vault: Vault, plugin: ObsidianGit) {
        super(vault, plugin);
        this.pluginRef = plugin;

        // Rebind readFile/writeFile via the promises map that MyAdapter
        // exposes to isomorphic-git. Without this, isomorphic-git keeps
        // calling MyAdapter.readFile directly, bypassing our overrides.
        this.promises.readFile = this.readFile.bind(this);
        this.promises.writeFile = this.writeFile.bind(this);
    }

    setKeys(keys: VaultKeys | undefined): void {
        this.keys = keys;
    }

    hasKeys(): boolean {
        return this.keys !== undefined;
    }

    /**
     * A path is treated as a vault file (encryption candidate) if it is
     * NOT inside the .git directory and NOT one of the few files git itself
     * must be able to read as plaintext (.gitattributes, .gitignore).
     */
    private isVaultFile(path: string): boolean {
        const gitDir = this.pluginRef.settings.gitDir || ".git";
        if (path.includes(`/${gitDir}/`) || path.startsWith(`${gitDir}/`)) {
            return false;
        }
        // Files git itself must read as plaintext.
        if (
            path === ".gitattributes" ||
            path.endsWith("/.gitattributes") ||
            path === ".gitignore" ||
            path.endsWith("/.gitignore")
        ) {
            return false;
        }
        return true;
    }

    private async toBytes(
        data: string | ArrayBuffer | Uint8Array
    ): Promise<Uint8Array> {
        if (typeof data === "string") {
            return new TextEncoder().encode(data);
        }
        if (data instanceof Uint8Array) return data;
        return new Uint8Array(data);
    }

    override async readFile(path: string, opts: any): Promise<any> {
        const raw = await super.readFile(path, opts);

        // Encryption disabled (no keys set) — passthrough behavior identical
        // to upstream MyAdapter.
        if (!this.keys) return raw;
        if (!this.isVaultFile(path)) return raw;

        const bytes = await this.toBytes(raw);

        // Already encrypted on disk? Pass the ciphertext through unchanged
        // — git stages exactly what's on disk, so this is fine.
        if (isEncrypted(bytes)) {
            return bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength
            );
        }

        // Plaintext on disk → encrypt before handing to git.
        const ct = await encrypt(bytes, this.keys);
        return ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength);
    }

    override async writeFile(
        path: string,
        data: string | ArrayBuffer
    ): Promise<any> {
        if (!this.keys) return super.writeFile(path, data);
        if (!this.isVaultFile(path)) return super.writeFile(path, data);

        const bytes = await this.toBytes(data);

        // Encrypted bytes coming from git's object store → decrypt before
        // writing to the vault, so Obsidian sees plaintext.
        if (isEncrypted(bytes)) {
            const pt = await decrypt(bytes, this.keys);
            return super.writeFile(
                path,
                pt.buffer.slice(pt.byteOffset, pt.byteOffset + pt.byteLength)
            );
        }

        // Not encrypted (shouldn't normally happen on writeFile after init,
        // but tolerated for first migration) — write through as plaintext.
        return super.writeFile(path, data);
    }
}
