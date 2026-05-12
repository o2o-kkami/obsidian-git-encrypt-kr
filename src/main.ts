import { Errors } from "isomorphic-git";
import type { Debouncer, Menu, TAbstractFile, WorkspaceLeaf } from "obsidian";
import {
    debounce,
    FileSystemAdapter,
    MarkdownView,
    normalizePath,
    Notice,
    Platform,
    Plugin,
    TFile,
    TFolder,
    moment,
} from "obsidian";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { pluginRef } from "src/pluginGlobalRef";
import { PromiseQueue } from "src/promiseQueue";
import { ObsidianGitSettingsTab } from "src/setting/settings";
import { StatusBar } from "src/statusBar";
import { AuthorInfoModal } from "src/ui/modals/authorInfoModal";
import { CustomMessageModal } from "src/ui/modals/customMessageModal";
import AutomaticsManager from "./automaticsManager";
import { addCommmands } from "./commands";
import {
    CONFLICT_OUTPUT_FILE,
    DEFAULT_GITIGNORE,
    DEFAULT_SETTINGS,
    DIFF_VIEW_CONFIG,
    HISTORY_VIEW_CONFIG,
    SOURCE_CONTROL_VIEW_CONFIG,
    SPLIT_DIFF_VIEW_CONFIG,
} from "./constants";
import type { GitManager } from "./gitManager/gitManager";
import { IsomorphicGit } from "./gitManager/isomorphicGit";
import { SimpleGit } from "./gitManager/simpleGit";
import { LocalStorageSettings } from "./setting/localStorageSettings";
import Tools from "./tools";
import type {
    FileStatusResult,
    ObsidianGitSettings,
    PluginState,
    Status,
    UnstagedFile,
} from "./types";
import {
    CurrentGitAction,
    mergeSettingsByPriority,
    NoNetworkError,
} from "./types";
import DiffView from "./ui/diff/diffView";
import SplitDiffView from "./ui/diff/splitDiffView";
import HistoryView from "./ui/history/historyView";
import { BranchModal } from "./ui/modals/branchModal";
import { GeneralModal } from "./ui/modals/generalModal";
import GitView from "./ui/sourceControl/sourceControl";
import { BranchStatusBar } from "./ui/statusBar/branchStatusBar";
import {
    assertNever,
    convertPathToAbsoluteGitignoreRule,
    formatRemoteUrl,
    spawnAsync,
    splitRemoteBranch,
} from "./utils";
import { DiscardModal, type DiscardResult } from "./ui/modals/discardModal";
import { HunkActions } from "./editor/signs/hunkActions";
import { EditorIntegration } from "./editor/editorIntegration";
import { deriveKeys } from "./crypto/vaultCrypto";

export default class ObsidianGit extends Plugin {
    gitManager: GitManager;
    automaticsManager = new AutomaticsManager(this);
    tools = new Tools(this);
    localStorage = new LocalStorageSettings(this);
    settings: ObsidianGitSettings;
    settingsTab?: ObsidianGitSettingsTab;
    statusBar?: StatusBar;
    branchBar?: BranchStatusBar;
    state: PluginState = {
        gitAction: CurrentGitAction.idle,
        offlineMode: false,
    };
    lastPulledFiles: FileStatusResult[];
    gitReady = false;
    promiseQueue: PromiseQueue = new PromiseQueue(this);

    /**
     * Derived encryption keys, populated by {@link loadEncryptionKeys} when
     * encryption is enabled and a password is available in localStorage.
     * Undefined when encryption is off or the password hasn't been set on
     * this device yet.
     */
    encryptionKeys: import("./crypto/vaultCrypto").VaultKeys | undefined;

    /**
     * Debouncer for the auto commit after file changes.
     */
    autoCommitDebouncer: Debouncer<[], void> | undefined;
    cachedStatus: Status | undefined;
    // Used to store the path of the file that is currently shown in the diff view.
    lastDiffViewState: Record<string, unknown> | undefined;
    intervalsToClear: number[] = [];
    editorIntegration: EditorIntegration = new EditorIntegration(this);
    hunkActions = new HunkActions(this);

    /**
     * Debouncer for the refresh of the git status for the source control view after file changes.
     */
    debRefresh: Debouncer<[], void>;

    setPluginState(state: Partial<PluginState>): void {
        this.state = Object.assign(this.state, state);
        this.statusBar?.display();
    }

    async updateCachedStatus(): Promise<Status> {
        this.app.workspace.trigger("obsidian-git:loading-status");
        this.cachedStatus = await this.gitManager.status();
        if (this.cachedStatus.conflicted.length > 0) {
            this.localStorage.setConflict(true);
            await this.branchBar?.display();
        } else {
            this.localStorage.setConflict(false);
            await this.branchBar?.display();
        }

        this.app.workspace.trigger(
            "obsidian-git:status-changed",
            this.cachedStatus
        );
        return this.cachedStatus;
    }

    async refresh() {
        if (!this.gitReady) return;

        const gitViews = this.app.workspace.getLeavesOfType(
            SOURCE_CONTROL_VIEW_CONFIG.type
        );
        const historyViews = this.app.workspace.getLeavesOfType(
            HISTORY_VIEW_CONFIG.type
        );

        if (
            this.settings.changedFilesInStatusBar ||
            gitViews.some((leaf) => !(leaf.isDeferred ?? false)) ||
            historyViews.some((leaf) => !(leaf.isDeferred ?? false))
        ) {
            await this.updateCachedStatus().catch((e) => this.displayError(e));
        }

        this.app.workspace.trigger("obsidian-git:refreshed");

        // We don't put a line authoring refresh here, as it would force a re-loading
        // of the line authoring feature - which would lead to a jumpy editor-view in the
        // ui after every rename event.
    }

    refreshUpdatedHead() {}

    async onload() {
        console.log(
            "loading " +
                this.manifest.name +
                " plugin: v" +
                this.manifest.version
        );

        pluginRef.plugin = this;

        this.localStorage.migrate();
        await this.loadSettings();
        await this.migrateSettings();

        this.settingsTab = new ObsidianGitSettingsTab(this.app, this);
        this.addSettingTab(this.settingsTab);

        if (!this.localStorage.getPluginDisabled()) {
            this.registerStuff();

            this.app.workspace.onLayoutReady(() =>
                this.init({ fromReload: false }).catch((e) =>
                    this.displayError(e)
                )
            );
        }
    }

    onExternalSettingsChange() {
        this.reloadSettings().catch((e) => this.displayError(e));
    }

    /** Reloads the settings from disk and applies them by unloading the plugin
     * and initializing it again.
     */
    async reloadSettings(): Promise<void> {
        const previousSettings = JSON.stringify(this.settings);

        await this.loadSettings();

        const newSettings = JSON.stringify(this.settings);

        // Only reload plugin if the settings have actually changed
        if (previousSettings !== newSettings) {
            this.log("Reloading settings");

            this.unloadPlugin();

            await this.init({ fromReload: true });

            this.app.workspace
                .getLeavesOfType(SOURCE_CONTROL_VIEW_CONFIG.type)
                .forEach((leaf) => {
                    if (!(leaf.isDeferred ?? false))
                        return (leaf.view as GitView).reload();
                });

            this.app.workspace
                .getLeavesOfType(HISTORY_VIEW_CONFIG.type)
                .forEach((leaf) => {
                    if (!(leaf.isDeferred ?? false))
                        return (leaf.view as HistoryView).reload();
                });
        }
    }

    /** This method only registers events, views, commands and more.
     *
     * This only needs to be called once since the registered events are
     * unregistered when the plugin is unloaded.
     *
     * This mustn't depend on the plugin's settings.
     */
    registerStuff(): void {
        this.registerEvent(
            this.app.workspace.on("obsidian-git:refresh", () => {
                this.refresh().catch((e) => this.displayError(e));
            })
        );
        this.registerEvent(
            this.app.workspace.on("obsidian-git:head-change", () => {
                this.refreshUpdatedHead();
            })
        );

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file, source) => {
                this.handleFileMenu(menu, file, source, "file-manu");
            })
        );

        this.registerEvent(
            this.app.workspace.on("obsidian-git:menu", (menu, path, source) => {
                this.handleFileMenu(menu, path, source, "obsidian-git:menu");
            })
        );

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (leaf) => {
                this.onActiveLeafChange(leaf);
            })
        );
        this.registerEvent(
            this.app.vault.on("modify", () => {
                this.debRefresh();
                this.autoCommitDebouncer?.();
            })
        );
        this.registerEvent(
            this.app.vault.on("delete", () => {
                this.debRefresh();
                this.autoCommitDebouncer?.();
            })
        );
        this.registerEvent(
            this.app.vault.on("create", () => {
                this.debRefresh();
                this.autoCommitDebouncer?.();
            })
        );
        this.registerEvent(
            this.app.vault.on("rename", () => {
                this.debRefresh();
                this.autoCommitDebouncer?.();
            })
        );

        this.registerView(SOURCE_CONTROL_VIEW_CONFIG.type, (leaf) => {
            return new GitView(leaf, this);
        });

        this.registerView(HISTORY_VIEW_CONFIG.type, (leaf) => {
            return new HistoryView(leaf, this);
        });

        this.registerView(DIFF_VIEW_CONFIG.type, (leaf) => {
            return new DiffView(leaf, this);
        });

        this.registerView(SPLIT_DIFF_VIEW_CONFIG.type, (leaf) => {
            return new SplitDiffView(leaf, this);
        });
        this.addRibbonIcon(
            "git-pull-request",
            "Git 소스 컨트롤 열기",
            async () => {
                const leafs = this.app.workspace.getLeavesOfType(
                    SOURCE_CONTROL_VIEW_CONFIG.type
                );
                let leaf: WorkspaceLeaf;
                if (leafs.length === 0) {
                    leaf =
                        this.app.workspace.getRightLeaf(false) ??
                        this.app.workspace.getLeaf();
                    await leaf.setViewState({
                        type: SOURCE_CONTROL_VIEW_CONFIG.type,
                    });
                } else {
                    leaf = leafs.first()!;
                }
                await this.app.workspace.revealLeaf(leaf);
            }
        );

        this.registerHoverLinkSource(SOURCE_CONTROL_VIEW_CONFIG.type, {
            display: "Git 뷰",
            defaultMod: true,
        });

        this.editorIntegration.onLoadPlugin();

        this.setRefreshDebouncer();

        addCommmands(this);
    }

    setRefreshDebouncer(): void {
        this.debRefresh?.cancel();
        this.debRefresh = debounce(
            () => {
                if (this.settings.refreshSourceControl) {
                    this.refresh().catch(console.error);
                }
            },
            this.settings.refreshSourceControlTimer,
            true
        );
    }

    async addFileToGitignore(
        filePath: string,
        isFolder?: boolean
    ): Promise<void> {
        const gitRelativePath = this.gitManager.getRelativeRepoPath(
            filePath,
            true
        );
        // Define an absolute rule that can apply only for this item.
        const gitignoreRule = convertPathToAbsoluteGitignoreRule({
            isFolder,
            gitRelativePath,
        });
        await this.app.vault.adapter.append(
            this.gitManager.getRelativeVaultPath(".gitignore"),
            "\n" + gitignoreRule
        );
        this.app.workspace.trigger("obsidian-git:refresh");
    }

    handleFileMenu(
        menu: Menu,
        file: TAbstractFile | string,
        source: string,
        type: "file-manu" | "obsidian-git:menu"
    ): void {
        if (!this.gitReady) return;
        if (!this.settings.showFileMenu) return;
        if (!file) return;
        let filePath: string;
        if (typeof file === "string") {
            filePath = file;
        } else {
            filePath = file.path;
        }

        if (source == "file-explorer-context-menu") {
            menu.addItem((item) => {
                item.setTitle(`Git: Stage (staging에 추가)`)
                    .setIcon("plus-circle")
                    .setSection("action")
                    .onClick((_) => {
                        this.promiseQueue.addTask(async () => {
                            if (file instanceof TFile) {
                                await this.stageFile(file);
                            } else {
                                await this.gitManager.stageAll({
                                    dir: this.gitManager.getRelativeRepoPath(
                                        filePath,
                                        true
                                    ),
                                });
                                this.app.workspace.trigger(
                                    "obsidian-git:refresh"
                                );
                            }
                        });
                    });
            });
            menu.addItem((item) => {
                item.setTitle(`Git: Unstage (staging에서 제거)`)
                    .setIcon("minus-circle")
                    .setSection("action")
                    .onClick((_) => {
                        this.promiseQueue.addTask(async () => {
                            if (file instanceof TFile) {
                                await this.unstageFile(file);
                            } else {
                                await this.gitManager.unstageAll({
                                    dir: this.gitManager.getRelativeRepoPath(
                                        filePath,
                                        true
                                    ),
                                });

                                this.app.workspace.trigger(
                                    "obsidian-git:refresh"
                                );
                            }
                        });
                    });
            });
            menu.addItem((item) => {
                item.setTitle(`Git: .gitignore에 추가`)
                    .setIcon("file-x")
                    .setSection("action")
                    .onClick((_) => {
                        this.addFileToGitignore(
                            filePath,
                            file instanceof TFolder
                        ).catch((e) => this.displayError(e));
                    });
            });
        }

        if (source == "git-source-control") {
            menu.addItem((item) => {
                item.setTitle(`Git: .gitignore에 추가`)
                    .setIcon("file-x")
                    .setSection("action")
                    .onClick((_) => {
                        this.addFileToGitignore(
                            filePath,
                            file instanceof TFolder
                        ).catch((e) => this.displayError(e));
                    });
            });
            const gitManager = this.app.vault.adapter;
            if (
                type === "obsidian-git:menu" &&
                gitManager instanceof FileSystemAdapter
            ) {
                menu.addItem((item) => {
                    item.setTitle("기본 앱으로 열기")
                        .setIcon("arrow-up-right")
                        .setSection("action")
                        .onClick((_) => {
                            this.app.openWithDefaultApp(filePath);
                        });
                });
                menu.addItem((item) => {
                    item.setTitle("탐색기에서 보기")
                        .setIcon("arrow-up-right")
                        .setSection("action")
                        .onClick((_) => {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                            (window as any).electron.shell.showItemInFolder(
                                path.join(gitManager.getBasePath(), filePath)
                            );
                        });
                });
            }
        }
    }

    async migrateSettings(): Promise<void> {
        if (this.settings.mergeOnPull != undefined) {
            this.settings.syncMethod = this.settings.mergeOnPull
                ? "merge"
                : "rebase";
            this.settings.mergeOnPull = undefined;
            await this.saveSettings();
        }
        if (this.settings.autoCommitMessage === undefined) {
            this.settings.autoCommitMessage = this.settings.commitMessage;
            await this.saveSettings();
        }
        if (this.settings.gitPath != undefined) {
            this.localStorage.setGitPath(this.settings.gitPath);
            this.settings.gitPath = undefined;
            await this.saveSettings();
        }
        if (this.settings.username != undefined) {
            this.localStorage.setPassword(this.settings.username);
            this.settings.username = undefined;
            await this.saveSettings();
        }
    }

    unloadPlugin() {
        this.gitReady = false;

        this.editorIntegration.onUnloadPlugin();
        this.automaticsManager.unload();
        this.branchBar?.remove();
        this.statusBar?.remove();
        this.statusBar = undefined;
        this.branchBar = undefined;
        this.gitManager.unload();
        this.promiseQueue.clear();

        for (const interval of this.intervalsToClear) {
            window.clearInterval(interval);
        }
        this.intervalsToClear = [];

        this.debRefresh.cancel();
    }

    onunload() {
        this.unloadPlugin();

        console.log("unloading " + this.manifest.name + " plugin");
    }

    async loadSettings() {
        // At first startup, `data` is `null` because data.json does not exist.
        let data = (await this.loadData()) as ObsidianGitSettings | null;
        //Check for existing settings
        if (data == undefined) {
            data = <ObsidianGitSettings>{ showedMobileNotice: true };
        }
        this.settings = mergeSettingsByPriority(DEFAULT_SETTINGS, data);
    }

    async saveSettings() {
        this.settingsTab?.beforeSaveSettings();
        await this.saveData(this.settings);
    }

    /**
     * Encryption-fork onboarding: make sure `user.name` and `user.email`
     * are set in `.git/config` before any commit runs. Called from
     * {@link init} during the "valid repo" branch, so we know
     * `gitManager.getConfig` / `setConfig` will work.
     *
     * Flow:
     *   - Both fields already set → no-op (silent).
     *   - Either field missing → open {@link AuthorInfoModal}:
     *       - User submits name+email → persist via setConfig.
     *       - User picks "건너뛰기 (Anonymous 사용)" → persist a dummy
     *         identity ("Anonymous" / "anonymous@local") and surface a
     *         notice nudging them to set a real one if they collaborate.
     *       - User dismisses the modal (Esc / 바깥 클릭) → do nothing.
     *         Next init re-prompts. Better than silently filling in
     *         garbage behind the user's back.
     */
    async ensureAuthorInfo(): Promise<void> {
        try {
            const gm = this.gitManager;
            const name = await gm.getConfig("user.name");
            const email = await gm.getConfig("user.email");
            if (name && email) return;

            const result = await new AuthorInfoModal(
                this.app
            ).openAndGetResult();

            if (result.kind === "input") {
                await gm.setConfig("user.name", result.name);
                await gm.setConfig("user.email", result.email);
                new Notice("Git 작성자 정보가 저장되었습니다.");
            } else if (result.kind === "skip") {
                await gm.setConfig("user.name", "Anonymous");
                await gm.setConfig("user.email", "anonymous@local");
                new Notice(
                    "익명으로 commit 작성자를 설정했습니다. 협업 vault라면 설정 화면에서 변경하세요.",
                    8000
                );
            }
            // result.kind === "cancel" → leave .git/config as-is; next
            // init() will surface the modal again. (Commit will still
            // fail with the upstream error message if the user keeps
            // dismissing the modal, but at least we tried first.)
        } catch (e) {
            console.error("ensureAuthorInfo 실패:", e);
            // Don't block init on this — let upstream's checkAuthorInfo
            // raise its own error at commit time if we couldn't help.
        }
    }

    get useSimpleGit(): boolean {
        return Platform.isDesktopApp;
    }

    /**
     * True when encryption is enabled in settings but no usable keys are
     * loaded (no password set on this device). In this state every git
     * operation MUST be blocked — otherwise plaintext would be pushed or
     * encrypted-looking bytes would be written into the vault unchanged.
     */
    isEncryptionLocked(): boolean {
        return (
            this.settings.encryption.enabled &&
            this.encryptionKeys === undefined
        );
    }

    /** Show the standard locked-state notice. Returns true (for use in
     *  guard expressions like `if (locked) { notify(); return false; }`). */
    private notifyEncryptionLocked(): true {
        new Notice(
            "🔒 암호화 비밀번호가 입력되지 않았습니다. 설정에서 비밀번호를 입력해야 동기화가 동작합니다.",
            10000
        );
        return true;
    }

    /** Single-point guard for sync operations. Returns true if blocked. */
    blockIfEncryptionLocked(): boolean {
        if (this.isEncryptionLocked()) {
            this.notifyEncryptionLocked();
            return true;
        }
        return false;
    }

    /**
     * Populate {@link encryptionKeys} from the password in localStorage.
     * Must be called before constructing IsomorphicGit so the
     * EncryptedAdapter has keys ready.
     *
     * No cross-device state is needed — the salt is a fixed plugin
     * constant (see vaultCrypto.ts), so identical password input on every
     * device deterministically yields the same keys.
     */
    async loadEncryptionKeys(): Promise<void> {
        if (!this.settings.encryption.enabled) {
            this.encryptionKeys = undefined;
            return;
        }
        const password = this.localStorage.getEncryptionPassword();
        if (!password) {
            this.encryptionKeys = undefined;
            return;
        }
        try {
            this.encryptionKeys = await deriveKeys(password);
        } catch (e) {
            console.error("암호화 키 derive 실패:", e);
            this.encryptionKeys = undefined;
        }
    }

    async init({ fromReload = false }): Promise<void> {
        if (this.settings.showStatusBar && !this.statusBar) {
            const statusBarEl = this.addStatusBarItem();
            this.statusBar = new StatusBar(statusBarEl, this);
            this.intervalsToClear.push(
                window.setInterval(() => this.statusBar?.display(), 1000)
            );
        }

        // Load encryption keys before constructing the git manager so the
        // adapter has them at instantiation time. Encryption requires
        // isomorphic-git (simple-git bypasses the adapter entirely).
        await this.loadEncryptionKeys();
        const encryptionForcesIsomorphic = this.settings.encryption.enabled;

        try {
            if (this.useSimpleGit && !encryptionForcesIsomorphic) {
                this.gitManager = new SimpleGit(this);
                await (this.gitManager as SimpleGit).setGitInstance();
            } else {
                this.gitManager = new IsomorphicGit(this);
            }

            const result = await this.gitManager.checkRequirements();
            const pausedAutomatics = this.localStorage.getPausedAutomatics();
            switch (result) {
                case "missing-git":
                    this.displayError(
                        `git 명령을 실행할 수 없습니다. 시도한 경로: '${this.localStorage.getGitPath() || "git"}'`
                    );
                    break;
                case "missing-repo":
                    new Notice(
                        "유효한 git 저장소를 찾을 수 없습니다. 커맨드로 새 저장소를 만들거나 기존 저장소를 clone하세요.",
                        10000
                    );
                    break;
                case "valid": {
                    this.gitReady = true;
                    this.setPluginState({ gitAction: CurrentGitAction.idle });

                    if (
                        Platform.isDesktop &&
                        this.settings.showBranchStatusBar &&
                        !this.branchBar
                    ) {
                        const branchStatusBarEl = this.addStatusBarItem();
                        this.branchBar = new BranchStatusBar(
                            branchStatusBarEl,
                            this
                        );
                        this.intervalsToClear.push(
                            window.setInterval(
                                () =>
                                    void this.branchBar
                                        ?.display()
                                        .catch(console.error),
                                60000
                            )
                        );
                    }
                    await this.branchBar?.display();

                    this.editorIntegration.onReady();

                    this.app.workspace.trigger("obsidian-git:refresh");
                    /// Among other things, this notifies the history view that git is ready
                    this.app.workspace.trigger("obsidian-git:head-change");

                    // SAFETY: if encryption is enabled but the password
                    // hasn't been set on this device, do NOT start any sync
                    // routines — they would push plaintext or write
                    // un-decrypted bytes into the vault.
                    const locked = this.isEncryptionLocked();

                    // Fork policy: seed a default .gitignore on disk BEFORE
                    // any sync timer can fire. Without this, an auto
                    // commit-and-sync that wins the race against the user
                    // opening the settings tab would call statusMatrix on a
                    // vault that has no ignore rules, mark .obsidian/* as
                    // untracked, stageAll them, and silently push the whole
                    // .obsidian tree to origin. Once a file is tracked,
                    // adding it to .gitignore later does NOT untrack it,
                    // so the only safe place to plug this hole is at
                    // plugin init, before any timer/auto-pull-on-boot
                    // gets a chance to run.
                    //
                    // exists() is intentional: if the user already has a
                    // .gitignore (auto-pulled here at some point, written
                    // manually, or deliberately blanked out), we don't
                    // overwrite it. Only "fresh device, no .gitignore yet"
                    // gets the default. Anything they do after this is
                    // their explicit intent and we keep our hands off.
                    if (!locked) {
                        const adapter = this.app.vault.adapter;
                        const gitignorePath =
                            this.gitManager.getRelativeVaultPath(".gitignore");
                        if (!(await adapter.exists(gitignorePath))) {
                            await adapter.write(
                                gitignorePath,
                                DEFAULT_GITIGNORE
                            );
                        }
                    }

                    // Fork policy: author info onboarding. checkAuthorInfo()
                    // in IsomorphicGit throws an opaque "set name+email
                    // in settings" error at commit time, which is bad UX
                    // (user already configured everything, ran init/clone,
                    // and hits the wall on first commit). Prompt up front
                    // instead: if user.name/user.email aren't both set in
                    // .git/config, open an onboarding modal once that
                    // accepts a name+email or a "skip → Anonymous" option,
                    // and persist the result back to .git/config. Skipped
                    // when encryption is locked since no commit can run
                    // in that state anyway.
                    if (!locked) {
                        await this.ensureAuthorInfo();
                    }

                    if (
                        !fromReload &&
                        this.settings.autoPullOnBoot &&
                        !pausedAutomatics &&
                        !locked
                    ) {
                        this.promiseQueue.addTask(() =>
                            this.pullChangesFromRemote()
                        );
                    }

                    if (!pausedAutomatics && !locked) {
                        await this.automaticsManager.init();
                    } else {
                        // Tear down any previously-running automatics so
                        // they cannot keep firing after entering the
                        // paused/locked state mid-session.
                        this.automaticsManager.unload();
                    }

                    if (pausedAutomatics) {
                        new Notice("자동화가 현재 일시정지 상태입니다.");
                    } else if (locked) {
                        new Notice(
                            "🔒 암호화가 활성화되어 있지만 비밀번호가 입력되지 않았습니다. 설정에서 비밀번호를 입력하면 동기화가 자동 시작됩니다.",
                            10000
                        );
                    }

                    break;
                }
                default:
                    this.log(
                        "예상치 못한 상황. 'checkRequirements' 결과: " +
                            /* eslint-disable-next-line @typescript-eslint/restrict-plus-operands */
                            result
                    );
            }
        } catch (error) {
            this.displayError(error);
            console.error(error);
        }
    }

    async createNewRepo() {
        try {
            await this.gitManager.init();
            new Notice("새 저장소를 초기화했습니다.");
            await this.init({ fromReload: true });
        } catch (e) {
            this.displayError(e);
        }
    }

    async cloneNewRepo() {
        if (this.blockIfEncryptionLocked()) return;
        const modal = new GeneralModal(this, {
            placeholder: "원격 URL 입력",
        });
        const url = await modal.openAndGetResult();
        if (url) {
            const confirmOption = "Vault 루트";
            let dir = await new GeneralModal(this, {
                options:
                    this.gitManager instanceof IsomorphicGit
                        ? [confirmOption]
                        : [],
                placeholder:
                    "clone할 디렉토리를 입력하세요. 비어있거나 존재하지 않는 디렉토리여야 합니다.",
                allowEmpty: this.gitManager instanceof IsomorphicGit,
            }).openAndGetResult();
            if (dir == undefined) return;
            if (dir === confirmOption) {
                dir = ".";
            }

            dir = normalizePath(dir);
            if (dir === "/") {
                dir = ".";
            }

            if (dir === ".") {
                const modal = new GeneralModal(this, {
                    options: ["아니오", "예"],
                    placeholder: `원격 저장소 루트에 ${this.app.vault.configDir} 디렉토리가 있습니까?`,
                    onlySelection: true,
                });
                const containsConflictDir = await modal.openAndGetResult();
                if (containsConflictDir === undefined) {
                    new Notice("Clone이 중단되었습니다.");
                    return;
                } else if (containsConflictDir === "예") {
                    const confirmOption = "로컬 설정과 플러그인을 모두 삭제";
                    const modal = new GeneralModal(this, {
                        options: ["Clone 중단", confirmOption],
                        placeholder: `충돌 방지를 위해 로컬 ${this.app.vault.configDir} 디렉토리를 삭제해야 합니다.`,
                        onlySelection: true,
                    });
                    const shouldDelete =
                        (await modal.openAndGetResult()) === confirmOption;
                    if (shouldDelete) {
                        await this.app.vault.adapter.rmdir(
                            this.app.vault.configDir,
                            true
                        );
                    } else {
                        new Notice("Clone이 중단되었습니다.");
                        return;
                    }
                }
            }
            const depth = await new GeneralModal(this, {
                placeholder:
                    "clone 깊이(depth)를 입력하세요. 비워두면 전체 clone.",
                allowEmpty: true,
            }).openAndGetResult();
            let depthInt = undefined;
            if (depth === undefined) {
                new Notice("Clone이 중단되었습니다.");
                return;
            }

            if (depth !== "") {
                depthInt = parseInt(depth);
                if (isNaN(depthInt)) {
                    new Notice("유효하지 않은 depth 값. clone을 중단합니다.");
                    return;
                }
            }
            new Notice(`"${dir}" 위치로 새 저장소를 clone합니다.`);
            const oldBase = this.settings.basePath;
            const customDir = dir && dir !== ".";
            //Set new base path before clone to ensure proper .git/index file location in isomorphic-git
            if (customDir) {
                this.settings.basePath = dir;
            }
            try {
                await this.gitManager.clone(
                    formatRemoteUrl(url),
                    dir,
                    depthInt
                );
                new Notice("저장소 clone 완료.");
                new Notice("옵시디언을 재시작해 주세요.");

                if (customDir) {
                    await this.saveSettings();
                }
            } catch (error) {
                this.displayError(error);
                this.settings.basePath = oldBase;
                await this.saveSettings();
            }
        }
    }

    /**
     * Retries to call `this.init()` if necessary, otherwise returns directly
     * @returns true if `this.gitManager` is ready to be used, false if not.
     */
    async isAllInitialized(): Promise<boolean> {
        if (!this.gitReady) {
            await this.init({ fromReload: true });
        }
        return this.gitReady;
    }

    ///Used for command
    async pullChangesFromRemote(): Promise<void> {
        if (!(await this.isAllInitialized())) return;
        if (this.blockIfEncryptionLocked()) return;

        const filesUpdated = await this.pull();
        if (filesUpdated === false) {
            return;
        }
        if (!filesUpdated) {
            this.displayMessage("Pull: 모두 최신 상태입니다.");
        }

        if (this.gitManager instanceof SimpleGit) {
            const status = await this.updateCachedStatus();
            if (status.conflicted.length > 0) {
                this.displayError(
                    `${status.conflicted.length}개 파일에 충돌이 있습니다.`
                );
                await this.handleConflict(status.conflicted);
            }
        }

        this.app.workspace.trigger("obsidian-git:refresh");
        this.setPluginState({ gitAction: CurrentGitAction.idle });
    }

    async commitAndSync({
        fromAutoBackup,
        requestCustomMessage = false,
        commitMessage,
        onlyStaged = false,
    }: {
        fromAutoBackup: boolean;
        requestCustomMessage?: boolean;
        commitMessage?: string;
        onlyStaged?: boolean;
    }): Promise<void> {
        if (!(await this.isAllInitialized())) return;
        if (this.blockIfEncryptionLocked()) return;

        if (
            this.settings.syncMethod == "reset" &&
            this.settings.pullBeforePush
        ) {
            await this.pull();
        }

        const commitSuccessful = await this.commit({
            fromAuto: fromAutoBackup,
            requestCustomMessage,
            commitMessage,
            onlyStaged,
        });
        if (!commitSuccessful) {
            return;
        }

        if (
            this.settings.syncMethod != "reset" &&
            this.settings.pullBeforePush
        ) {
            await this.pull();
        }

        if (!this.settings.disablePush) {
            // Prevent trying to push every time. Only if unpushed commits are present
            if (
                (await this.remotesAreSet()) &&
                (await this.gitManager.canPush())
            ) {
                await this.push();
            } else {
                this.displayMessage("Push할 커밋이 없습니다.");
            }
        }
        this.setPluginState({ gitAction: CurrentGitAction.idle });
    }

    // Returns true if commit was successfully
    async commit({
        fromAuto,
        requestCustomMessage = false,
        onlyStaged = false,
        commitMessage,
        amend = false,
    }: {
        fromAuto: boolean;
        requestCustomMessage?: boolean;
        onlyStaged?: boolean;
        commitMessage?: string;
        amend?: boolean;
    }): Promise<boolean> {
        if (!(await this.isAllInitialized())) return false;
        if (this.blockIfEncryptionLocked()) return false;
        try {
            let hadConflict = this.localStorage.getConflict();

            let status: Status | undefined;
            let stagedFiles: { vaultPath: string; path: string }[] = [];
            let unstagedFiles: (UnstagedFile & { vaultPath: string })[] = [];

            if (this.gitManager instanceof SimpleGit) {
                await this.mayDeleteConflictFile();
                status = await this.updateCachedStatus();

                //Should not be necessary, but just in case
                if (status.conflicted.length == 0) {
                    hadConflict = false;
                }

                // check for conflict files on auto backup
                if (fromAuto && status.conflicted.length > 0) {
                    this.displayError(
                        `${status.conflicted.length}개 파일에 충돌이 있어 커밋하지 않았습니다. 충돌을 해결한 뒤 커맨드로 직접 커밋하세요.`
                    );
                    await this.handleConflict(status.conflicted);
                    return false;
                }
                stagedFiles = status.staged;

                // This typecast is only needed to hide the fact that `type` is missing, but that is only needed for isomorphic-git
                unstagedFiles = status.changed as unknown as (UnstagedFile & {
                    vaultPath: string;
                })[];
            } else {
                // isomorphic-git section

                if (fromAuto && hadConflict) {
                    // isomorphic-git doesn't have a way to detect current
                    // conflicts, they are only detected on commit
                    //
                    // Conflicts should only be resolved by manually committing.
                    this.displayError(
                        `충돌이 있어 커밋하지 않았습니다. 충돌을 해결한 뒤 커맨드로 직접 커밋하세요.`
                    );
                    return false;
                } else {
                    if (hadConflict) {
                        await this.mayDeleteConflictFile();
                    }
                    const gitManager = this.gitManager as IsomorphicGit;
                    if (onlyStaged) {
                        stagedFiles = await gitManager.getStagedFiles();
                    } else {
                        const res = await gitManager.getUnstagedFiles();
                        unstagedFiles = res.map(({ path, type }) => ({
                            vaultPath:
                                this.gitManager.getRelativeVaultPath(path),
                            path,
                            type,
                        }));
                    }
                }
            }

            if (
                await this.tools.hasTooBigFiles(
                    onlyStaged
                        ? stagedFiles
                        : [...stagedFiles, ...unstagedFiles]
                )
            ) {
                this.setPluginState({ gitAction: CurrentGitAction.idle });
                return false;
            }

            if (
                unstagedFiles.length + stagedFiles.length !== 0 ||
                hadConflict
            ) {
                // The commit message from settings or previously set in the
                // source control view
                let cmtMessage = (commitMessage ??= fromAuto
                    ? this.settings.autoCommitMessage
                    : this.settings.commitMessage);

                // Optionally ask the user via a modal for a commit message
                if (
                    (fromAuto && this.settings.customMessageOnAutoBackup) ||
                    requestCustomMessage
                ) {
                    if (!this.settings.disablePopups && fromAuto) {
                        new Notice(
                            "자동 백업: 커밋 메시지를 입력하세요. 비워두면 중단됩니다."
                        );
                    }
                    const modalMessage = await new CustomMessageModal(
                        this
                    ).openAndGetResult();

                    if (
                        modalMessage != undefined &&
                        modalMessage != "" &&
                        modalMessage != "..."
                    ) {
                        cmtMessage = modalMessage;
                    } else {
                        this.setPluginState({
                            gitAction: CurrentGitAction.idle,
                        });
                        return false;
                    }

                    // On desktop may run a script to get the commit message
                } else if (
                    this.gitManager instanceof SimpleGit &&
                    this.settings.commitMessageScript
                ) {
                    const templateScript = this.settings.commitMessageScript;
                    const hostname = this.localStorage.getHostname() || "";
                    let formattedScript = templateScript.replace(
                        "{{hostname}}",
                        hostname
                    );

                    formattedScript = formattedScript.replace(
                        "{{date}}",
                        moment().format(this.settings.commitDateFormat)
                    );
                    let shPath = "sh";
                    if (Platform.isWin) {
                        shPath =
                            process.env.PROGRAMFILES + "\\Git\\bin\\sh.exe";
                        let shExists = false;
                        try {
                            await fsPromises.access(
                                shPath,
                                fsPromises.constants.X_OK
                            );
                            shExists = true;
                        } catch {
                            shExists = false;
                        }

                        if (!shExists) {
                            this.displayError(
                                `${shPath} 경로에서 sh.exe를 찾을 수 없습니다. git이 올바르게 설치되었는지 확인하세요.`
                            );
                            return false;
                        }
                    }

                    const res = await spawnAsync(
                        shPath,
                        ["-c", formattedScript],
                        { cwd: this.gitManager.absoluteRepoPath }
                    );
                    if (res.code != 0) {
                        this.displayError(res.stderr);
                    } else if (res.stdout.trim().length == 0) {
                        this.displayMessage(
                            "커밋 메시지 스크립트의 출력이 비어있습니다. 기본 메시지를 사용합니다."
                        );
                    } else {
                        cmtMessage = res.stdout;
                    }
                }

                // Check if commit message is empty after all processing
                if (!cmtMessage || cmtMessage.trim() === "") {
                    new Notice("커밋 중단: 커밋 메시지가 입력되지 않았습니다.");
                    this.setPluginState({
                        gitAction: CurrentGitAction.idle,
                    });
                    return false;
                }

                let committedFiles: number | undefined;
                if (onlyStaged) {
                    committedFiles = await this.gitManager.commit({
                        message: cmtMessage,
                        amend,
                    });
                } else {
                    committedFiles = await this.gitManager.commitAll({
                        message: cmtMessage,
                        status,
                        unstagedFiles,
                        amend,
                    });
                }

                // Handle eventually resolved conflicts
                if (this.gitManager instanceof SimpleGit) {
                    await this.updateCachedStatus();
                }

                let roughly = false;
                if (committedFiles === undefined) {
                    roughly = true;
                    committedFiles =
                        unstagedFiles.length + stagedFiles.length || 0;
                }
                this.displayMessage(
                    `${roughly ? "약 " : ""}${committedFiles}개 파일을 커밋했습니다.`
                );
            } else {
                this.displayMessage("커밋할 변경사항이 없습니다.");
            }
            this.app.workspace.trigger("obsidian-git:refresh");

            return true;
        } catch (error) {
            this.displayError(error);
            return false;
        }
    }

    /*
     * Returns true if push was successful
     */
    async push(): Promise<boolean> {
        if (!(await this.isAllInitialized())) return false;
        if (this.blockIfEncryptionLocked()) return false;
        if (!(await this.remotesAreSet())) {
            return false;
        }
        const hadConflict = this.localStorage.getConflict();
        try {
            if (this.gitManager instanceof SimpleGit)
                await this.mayDeleteConflictFile();

            // Refresh because of pull
            let status: Status;
            if (
                this.gitManager instanceof SimpleGit &&
                (status = await this.updateCachedStatus()).conflicted.length > 0
            ) {
                this.displayError(
                    `Push 불가: ${status.conflicted.length}개 파일에 충돌이 있습니다.`
                );
                await this.handleConflict(status.conflicted);
                return false;
            } else if (
                this.gitManager instanceof IsomorphicGit &&
                hadConflict
            ) {
                this.displayError(`Push 불가: 충돌이 있습니다.`);
                return false;
            }
            this.log("Pushing....");
            const pushedFiles = await this.gitManager.push();

            if (pushedFiles !== undefined) {
                if (pushedFiles === null) {
                    this.displayMessage(`원격으로 push 완료.`);
                } else if (pushedFiles > 0) {
                    this.displayMessage(
                        `${pushedFiles}개 파일을 원격으로 push했습니다.`
                    );
                } else {
                    this.displayMessage(`Push할 커밋이 없습니다.`);
                }
            }
            this.setPluginState({ offlineMode: false });
            this.app.workspace.trigger("obsidian-git:refresh");
            return true;
        } catch (e) {
            if (e instanceof NoNetworkError) {
                this.handleNoNetworkError(e);
            } else {
                this.displayError(e);
            }
            return false;
        }
    }

    /** Used for internals
     *  Returns whether the pull added a commit or not.
     *
     *  See {@link pullChangesFromRemote} for the command version.
     */
    async pull(): Promise<false | number> {
        if (this.blockIfEncryptionLocked()) return false;
        if (!(await this.remotesAreSet())) {
            return false;
        }
        try {
            this.log("Pulling....");
            const pulledFiles = (await this.gitManager.pull()) || [];
            this.setPluginState({ offlineMode: false });

            if (pulledFiles.length > 0) {
                this.displayMessage(
                    `원격에서 ${pulledFiles.length}개 파일을 pull했습니다.`
                );
                this.lastPulledFiles = pulledFiles;
            }
            return pulledFiles.length;
        } catch (e) {
            this.displayError(e);

            return false;
        }
    }

    async fetch(): Promise<void> {
        if (this.blockIfEncryptionLocked()) return;
        if (!(await this.remotesAreSet())) {
            return;
        }
        try {
            await this.gitManager.fetch();

            this.displayMessage(`원격에서 fetch 완료.`);
            this.setPluginState({ offlineMode: false });
            this.app.workspace.trigger("obsidian-git:refresh");
        } catch (error) {
            this.displayError(error);
        }
    }

    async mayDeleteConflictFile(): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(CONFLICT_OUTPUT_FILE);
        if (file) {
            this.app.workspace.iterateAllLeaves((leaf) => {
                if (
                    leaf.view instanceof MarkdownView &&
                    leaf.view.file?.path == file.path
                ) {
                    leaf.detach();
                }
            });
            await this.app.vault.delete(file);
        }
    }

    async stageFile(file: TFile): Promise<boolean> {
        if (!(await this.isAllInitialized())) return false;

        await this.gitManager.stage(file.path, true);

        this.app.workspace.trigger("obsidian-git:refresh");

        this.setPluginState({ gitAction: CurrentGitAction.idle });
        return true;
    }

    async unstageFile(file: TFile): Promise<boolean> {
        if (!(await this.isAllInitialized())) return false;

        await this.gitManager.unstage(file.path, true);

        this.app.workspace.trigger("obsidian-git:refresh");

        this.setPluginState({ gitAction: CurrentGitAction.idle });
        return true;
    }

    async switchBranch(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const branchInfo = await this.gitManager.branchInfo();
        const selectedBranch = await new BranchModal(
            this,
            branchInfo.branches
        ).openAndGetReslt();

        if (selectedBranch != undefined) {
            await this.gitManager.checkout(selectedBranch);
            this.displayMessage(`${selectedBranch} 브랜치로 전환했습니다.`);
            this.app.workspace.trigger("obsidian-git:refresh");
            await this.branchBar?.display();
            return selectedBranch;
        }
    }

    async switchRemoteBranch(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const selectedBranch = (await this.selectRemoteBranch()) || "";

        const [remote, branch] = splitRemoteBranch(selectedBranch);

        if (branch != undefined && remote != undefined) {
            await this.gitManager.checkout(branch, remote);
            this.displayMessage(`${selectedBranch} 브랜치로 전환했습니다.`);
            await this.branchBar?.display();
            return selectedBranch;
        }
    }

    async createBranch(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const newBranch = await new GeneralModal(this, {
            placeholder: "새 브랜치 만들기",
        }).openAndGetResult();
        if (newBranch != undefined) {
            await this.gitManager.createBranch(newBranch);
            this.displayMessage(`새 브랜치 ${newBranch}를 생성했습니다.`);
            await this.branchBar?.display();
            return newBranch;
        }
    }

    async deleteBranch(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const branchInfo = await this.gitManager.branchInfo();
        if (branchInfo.current) branchInfo.branches.remove(branchInfo.current);
        const branch = await new GeneralModal(this, {
            options: branchInfo.branches,
            placeholder: "브랜치 삭제",
            onlySelection: true,
        }).openAndGetResult();
        if (branch != undefined) {
            let force = false;
            const merged = await this.gitManager.branchIsMerged(branch);
            // Using await inside IF throws exception
            if (!merged) {
                const forceAnswer = await new GeneralModal(this, {
                    options: ["예", "아니오"],
                    placeholder:
                        "이 브랜치는 HEAD에 머지되지 않았습니다. 강제 삭제하시겠습니까?",
                    onlySelection: true,
                }).openAndGetResult();
                if (forceAnswer !== "예") {
                    return;
                }
                force = forceAnswer === "예";
            }
            await this.gitManager.deleteBranch(branch, force);
            this.displayMessage(`${branch} 브랜치를 삭제했습니다.`);
            await this.branchBar?.display();
            return branch;
        }
    }

    /** Ensures that the upstream branch is set.
     * If not, it will prompt the user to set it.
     *
     * An exception is when the user has submodules enabled.
     * In this case, the upstream branch is not required,
     * to allow pulling/pushing only the submodules and not the outer repo.
     */
    async remotesAreSet(): Promise<boolean> {
        if (this.settings.updateSubmodules) {
            return true;
        }
        if (
            this.gitManager instanceof SimpleGit &&
            (await this.gitManager.getConfig("push.autoSetupRemote", "all")) ==
                "true"
        ) {
            return true;
        }
        if (!(await this.gitManager.branchInfo()).tracking) {
            new Notice("Upstream 브랜치가 설정되지 않았습니다. 선택해 주세요.");
            return await this.setUpstreamBranch();
        }
        return true;
    }

    async setUpstreamBranch(): Promise<boolean> {
        const remoteBranch = await this.selectRemoteBranch();

        if (remoteBranch == undefined) {
            this.displayError(
                "중단되었습니다. Upstream 브랜치가 설정되지 않았습니다.",
                10000
            );
            this.setPluginState({ gitAction: CurrentGitAction.idle });
            return false;
        } else {
            await this.gitManager.updateUpstreamBranch(remoteBranch);
            this.displayMessage(
                `Upstream 브랜치를 ${remoteBranch}로 설정했습니다.`
            );
            this.setPluginState({ gitAction: CurrentGitAction.idle });
            return true;
        }
    }

    async discardAll(path?: string): Promise<DiscardResult> {
        if (!(await this.isAllInitialized())) return false;

        const status = await this.gitManager.status({ path });

        let filesToDeleteCount = 0;
        let filesToDiscardCount = 0;
        for (const file of status.changed) {
            if (file.workingDir == "U") {
                filesToDeleteCount++;
            } else {
                filesToDiscardCount++;
            }
        }
        if (filesToDeleteCount + filesToDiscardCount == 0) {
            return false;
        }

        const result = await new DiscardModal({
            app: this.app,
            filesToDeleteCount,
            filesToDiscardCount,
            path: path ?? "",
        }).openAndGetResult();

        switch (result) {
            case false:
                return result;
            case "discard":
                await this.gitManager.discardAll({
                    dir: path,
                    status: this.cachedStatus,
                });
                break;
            case "delete": {
                await this.gitManager.discardAll({
                    dir: path,
                    status: this.cachedStatus,
                });
                const untrackedPaths = await this.gitManager.getUntrackedPaths({
                    path,
                    status: this.cachedStatus,
                });
                for (const file of untrackedPaths) {
                    const vaultPath =
                        this.gitManager.getRelativeVaultPath(file);
                    const tFile =
                        this.app.vault.getAbstractFileByPath(vaultPath);

                    if (tFile) {
                        await this.app.fileManager.trashFile(tFile);
                    } else {
                        if (file.endsWith("/")) {
                            await this.app.vault.adapter.rmdir(vaultPath, true);
                        } else {
                            await this.app.vault.adapter.remove(vaultPath);
                        }
                    }
                }
                break;
            }
            default:
                assertNever(result);
        }
        this.app.workspace.trigger("obsidian-git:refresh");
        return result;
    }

    async handleConflict(conflicted?: string[]): Promise<void> {
        this.localStorage.setConflict(true);
        let lines: string[] | undefined;
        if (conflicted !== undefined) {
            lines = [
                "# 충돌 발생",
                "충돌을 해결한 뒤 `Git: 모든 변경 커밋` 커맨드 다음 `Git: Push` 커맨드로 커밋하세요.",
                "(이 파일은 커밋 직전에 자동으로 삭제됩니다)",
                "[[#추가 안내]]는 파일 목록 아래에 있습니다.",
                "",
                ...conflicted.map((e) => {
                    const file = this.app.vault.getAbstractFileByPath(e);
                    if (file instanceof TFile) {
                        const link = this.app.metadataCache.fileToLinktext(
                            file,
                            "/"
                        );
                        return `- [[${link}]]`;
                    } else {
                        return `- 파일이 아님: ${e}`;
                    }
                }),
                `
# 추가 안내
충돌 파일은 "소스 모드"로 보는 것을 강력히 권장합니다. 단순 충돌의 경우 각 파일 안의 아래 텍스트 블록을 원하는 내용으로 교체하세요.

\`\`\`diff
<<<<<<< HEAD
    로컬 저장소의 변경사항
=======
    원격 저장소의 변경사항
>>>>>>> origin/main
\`\`\``,
            ];
        }
        await this.tools.writeAndOpenFile(lines?.join("\n"));
    }

    async editRemotes(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const remotes = await this.gitManager.getRemotes();

        const nameModal = new GeneralModal(this, {
            options: remotes,
            placeholder: "원격 이름을 선택하거나 새 이름을 입력해서 만드세요",
        });
        const remoteName = await nameModal.openAndGetResult();

        if (remoteName) {
            const oldUrl = await this.gitManager.getRemoteUrl(remoteName);

            const urlModal = new GeneralModal(this, {
                initialValue: oldUrl,
                placeholder: "원격 URL 입력",
            });
            // urlModal.inputEl.setText(oldUrl ?? "");
            const remoteURL = await urlModal.openAndGetResult();
            if (remoteURL) {
                await this.gitManager.setRemote(
                    remoteName,
                    formatRemoteUrl(remoteURL)
                );
                return remoteName;
            }
        }
    }

    async selectRemoteBranch(): Promise<string | undefined> {
        let remotes = await this.gitManager.getRemotes();
        let selectedRemote: string | undefined;
        if (remotes.length === 0) {
            selectedRemote = await this.editRemotes();
            if (selectedRemote == undefined) {
                remotes = await this.gitManager.getRemotes();
            }
        }

        const nameModal = new GeneralModal(this, {
            options: remotes,
            placeholder: "원격 이름을 선택하거나 새 이름을 입력해서 만드세요",
        });
        const remoteName =
            selectedRemote ?? (await nameModal.openAndGetResult());

        if (remoteName) {
            this.displayMessage("원격 브랜치 가져오는 중...");
            await this.gitManager.fetch(remoteName);
            const branches =
                await this.gitManager.getRemoteBranches(remoteName);
            const branchModal = new GeneralModal(this, {
                options: branches,
                placeholder:
                    "원격 브랜치를 선택하거나 새 브랜치 이름을 입력해서 만드세요",
            });
            const branch = await branchModal.openAndGetResult();
            if (branch == undefined) return;
            if (!branch.startsWith(remoteName + "/")) {
                // If the branch does not start with the remote name, prepend it
                return `${remoteName}/${branch}`;
            }
            return branch; // Already in the correct format
        }
    }

    async removeRemote() {
        if (!(await this.isAllInitialized())) return;

        const remotes = await this.gitManager.getRemotes();

        const nameModal = new GeneralModal(this, {
            options: remotes,
            placeholder: "원격 선택",
        });
        const remoteName = await nameModal.openAndGetResult();

        if (remoteName) {
            await this.gitManager.removeRemote(remoteName);
        }
    }

    onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
        const view = leaf?.view;
        // Prevent removing focus when switching to other panes than file panes like search or GitView
        if (
            !view?.getState().file &&
            !(view instanceof DiffView || view instanceof SplitDiffView)
        )
            return;

        const sourceControlLeaf = this.app.workspace
            .getLeavesOfType(SOURCE_CONTROL_VIEW_CONFIG.type)
            .first();
        const historyLeaf = this.app.workspace
            .getLeavesOfType(HISTORY_VIEW_CONFIG.type)
            .first();

        // Clear existing active state
        sourceControlLeaf?.view.containerEl
            .querySelector(`div.tree-item-self.is-active`)
            ?.removeClass("is-active");
        historyLeaf?.view.containerEl
            .querySelector(`div.tree-item-self.is-active`)
            ?.removeClass("is-active");

        if (
            leaf?.view instanceof DiffView ||
            leaf?.view instanceof SplitDiffView
        ) {
            const path = leaf.view.state.bFile;
            const escapedPath = path.replace(/["\\]/g, "\\$&");
            this.lastDiffViewState = leaf.view.getState();
            let el: Element | undefined | null;
            if (sourceControlLeaf && leaf.view.state.aRef == "HEAD") {
                el = sourceControlLeaf.view.containerEl.querySelector(
                    `div.staged div.tree-item-self[data-path="${escapedPath}"]`
                );
            } else if (sourceControlLeaf && leaf.view.state.aRef == "") {
                el = sourceControlLeaf.view.containerEl.querySelector(
                    `div.changes div.tree-item-self[data-path="${escapedPath}"]`
                );
            } else if (historyLeaf) {
                el = historyLeaf.view.containerEl.querySelector(
                    `div.tree-item-self[data-path='${escapedPath}']`
                );
            }
            el?.addClass("is-active");
        } else {
            this.lastDiffViewState = undefined;
        }
    }

    handleNoNetworkError(_: NoNetworkError): void {
        if (!this.state.offlineMode) {
            this.displayError(
                "Git: 오프라인 모드로 전환합니다. 이후의 네트워크 오류는 표시되지 않습니다.",
                2000
            );
        } else {
            this.log("네트워크 오류 발생, 이미 오프라인 모드입니다");
        }
        this.setPluginState({
            gitAction: CurrentGitAction.idle,
            offlineMode: true,
        });
    }

    // region: displaying / formatting messages
    displayMessage(message: string, timeout: number = 4 * 1000): void {
        this.statusBar?.displayMessage(message.toLowerCase(), timeout);

        if (!this.settings.disablePopups) {
            if (
                !this.settings.disablePopupsForNoChanges ||
                (!message.startsWith("커밋할 변경사항이 없습니다") &&
                    !message.startsWith("No changes"))
            ) {
                new Notice(message, 5 * 1000);
            }
        }

        this.log(message);
    }

    displayError(data: unknown, timeout: number = 10 * 1000): void {
        if (data instanceof Errors.UserCanceledError) {
            new Notice("중단되었습니다.");
            return;
        }
        let error: Error;
        if (data instanceof Error) {
            error = data;
        } else {
            error = new Error(String(data));
        }

        this.setPluginState({ gitAction: CurrentGitAction.idle });
        if (this.settings.showErrorNotices) {
            new Notice(error.message, timeout);
        }
        console.error(`${this.manifest.id}:`, error.stack);
        this.statusBar?.displayMessage(error.message.toLowerCase(), timeout);
    }

    log(...data: unknown[]) {
        console.log(`${this.manifest.id}:`, ...data);
    }
}
