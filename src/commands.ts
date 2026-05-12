import { Notice, Platform, TFolder, WorkspaceLeaf } from "obsidian";
import { HISTORY_VIEW_CONFIG, SOURCE_CONTROL_VIEW_CONFIG } from "./constants";
import { SimpleGit } from "./gitManager/simpleGit";
import ObsidianGit from "./main";
import { openHistoryInGitHub, openLineInGitHub } from "./openInGitHub";
import { ChangedFilesModal } from "./ui/modals/changedFilesModal";
import { GeneralModal } from "./ui/modals/generalModal";
import { IgnoreModal } from "./ui/modals/ignoreModal";
import { assertNever } from "./utils";
import { togglePreviewHunk } from "./editor/signs/tooltip";

export function addCommmands(plugin: ObsidianGit) {
    const app = plugin.app;

    plugin.addCommand({
        id: "edit-gitignore",
        name: ".gitignore 편집",
        callback: async () => {
            const path = plugin.gitManager.getRelativeVaultPath(".gitignore");
            if (!(await app.vault.adapter.exists(path))) {
                await app.vault.adapter.write(path, "");
            }
            const content = await app.vault.adapter.read(path);
            const modal = new IgnoreModal(app, content);
            const res = await modal.openAndGetReslt();
            if (res !== undefined) {
                await app.vault.adapter.write(path, res);
                await plugin.refresh();
            }
        },
    });
    plugin.addCommand({
        id: "untrack-gitignore",
        name: ".gitignore 추적 해제 (origin에서도 제거)",
        callback: async () => {
            // Encryption-fork policy: `.gitignore` is per-device env,
            // never shared. The stage paths already refuse to push it,
            // but origin may still hold a `.gitignore` from before the
            // fork was installed (or from a teammate's earlier commit).
            // This command runs `git rm --cached .gitignore` + a commit
            // + a push so origin stops carrying it. Teammates who pull
            // afterwards will see the working-tree copy disappear, and
            // their own plugin will regenerate a local default on next
            // settings-tab open. Collaborator coordination still
            // recommended — see README.
            const gm = plugin.gitManager;
            try {
                await gm.untrackFile(".gitignore");
                const n = await gm.commit({
                    message:
                        "chore: untrack .gitignore (encryption-fork policy)",
                });
                if (n === 0 || n === undefined) {
                    new Notice(
                        ".gitignore는 이미 추적 해제 상태입니다. 추가 작업이 필요 없습니다."
                    );
                    return;
                }
                await gm.push();
                new Notice(
                    ".gitignore의 추적이 해제되었고 origin에서도 제거되었습니다."
                );
            } catch (e) {
                console.error("untrack .gitignore 실패:", e);
                new Notice(
                    ".gitignore 추적 해제 실패 — 개발자 콘솔을 확인하세요"
                );
            }
        },
    });
    plugin.addCommand({
        id: "open-git-view",
        name: "소스 컨트롤 뷰 열기",
        callback: async () => {
            const leafs = app.workspace.getLeavesOfType(
                SOURCE_CONTROL_VIEW_CONFIG.type
            );
            let leaf: WorkspaceLeaf;
            if (leafs.length === 0) {
                leaf =
                    app.workspace.getRightLeaf(false) ??
                    app.workspace.getLeaf();
                await leaf.setViewState({
                    type: SOURCE_CONTROL_VIEW_CONFIG.type,
                });
            } else {
                leaf = leafs.first()!;
            }
            await app.workspace.revealLeaf(leaf);

            // Is not needed for the first open, but allows to refresh the view
            // per hotkey even if already opened
            app.workspace.trigger("obsidian-git:refresh");
        },
    });
    plugin.addCommand({
        id: "open-history-view",
        name: "히스토리 뷰 열기",
        callback: async () => {
            const leafs = app.workspace.getLeavesOfType(
                HISTORY_VIEW_CONFIG.type
            );
            let leaf: WorkspaceLeaf;
            if (leafs.length === 0) {
                leaf =
                    app.workspace.getRightLeaf(false) ??
                    app.workspace.getLeaf();
                await leaf.setViewState({
                    type: HISTORY_VIEW_CONFIG.type,
                });
            } else {
                leaf = leafs.first()!;
            }
            await app.workspace.revealLeaf(leaf);

            // Is not needed for the first open, but allows to refresh the view
            // per hotkey even if already opened
            app.workspace.trigger("obsidian-git:refresh");
        },
    });

    plugin.addCommand({
        id: "open-diff-view",
        name: "Diff 뷰 열기",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) {
                return file !== null;
            } else {
                const filePath = plugin.gitManager.getRelativeRepoPath(
                    file!.path,
                    true
                );
                plugin.tools.openDiff({
                    aFile: filePath,
                    aRef: "",
                });
            }
        },
    });

    plugin.addCommand({
        id: "view-file-on-github",
        name: "GitHub에서 파일 열기",
        editorCallback: (editor, { file }) => {
            if (file) return openLineInGitHub(editor, file, plugin.gitManager);
        },
    });

    plugin.addCommand({
        id: "view-history-on-github",
        name: "GitHub에서 파일 히스토리 열기",
        editorCallback: (_, { file }) => {
            if (file) return openHistoryInGitHub(file, plugin.gitManager);
        },
    });

    plugin.addCommand({
        id: "pull",
        name: "Pull",
        callback: () =>
            plugin.promiseQueue.addTask(() => plugin.pullChangesFromRemote()),
    });

    plugin.addCommand({
        id: "fetch",
        name: "Fetch",
        callback: () => plugin.promiseQueue.addTask(() => plugin.fetch()),
    });

    plugin.addCommand({
        id: "switch-to-remote-branch",
        name: "원격 브랜치로 전환",
        callback: () =>
            plugin.promiseQueue.addTask(() => plugin.switchRemoteBranch()),
    });

    plugin.addCommand({
        id: "add-to-gitignore",
        name: ".gitignore에 파일 추가",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) {
                return file !== null;
            } else {
                plugin
                    .addFileToGitignore(file!.path, file instanceof TFolder)
                    .catch((e) => plugin.displayError(e));
            }
        },
    });

    plugin.addCommand({
        id: "push",
        name: "커밋 & 동기화",
        callback: () =>
            plugin.promiseQueue.addTask(() =>
                plugin.commitAndSync({ fromAutoBackup: false })
            ),
    });

    plugin.addCommand({
        id: "backup-and-close",
        name: "커밋 & 동기화 후 옵시디언 종료",
        callback: () =>
            plugin.promiseQueue.addTask(async () => {
                await plugin.commitAndSync({ fromAutoBackup: false });
                window.close();
            }),
    });

    plugin.addCommand({
        id: "commit-push-specified-message",
        name: "커밋 & 동기화 (메시지 직접 입력)",
        callback: () =>
            plugin.promiseQueue.addTask(() =>
                plugin.commitAndSync({
                    fromAutoBackup: false,
                    requestCustomMessage: true,
                })
            ),
    });

    plugin.addCommand({
        id: "commit",
        name: "모든 변경 커밋",
        callback: () =>
            plugin.promiseQueue.addTask(() =>
                plugin.commit({ fromAuto: false })
            ),
    });

    plugin.addCommand({
        id: "commit-specified-message",
        name: "모든 변경 커밋 (메시지 직접 입력)",
        callback: () =>
            plugin.promiseQueue.addTask(() =>
                plugin.commit({
                    fromAuto: false,
                    requestCustomMessage: true,
                })
            ),
    });

    plugin.addCommand({
        id: "commit-smart",
        name: "커밋",
        callback: () =>
            plugin.promiseQueue.addTask(async () => {
                const status = await plugin.updateCachedStatus();
                const onlyStaged = status.staged.length > 0;
                return plugin.commit({
                    fromAuto: false,
                    requestCustomMessage: false,
                    onlyStaged: onlyStaged,
                });
            }),
    });

    plugin.addCommand({
        id: "commit-staged",
        name: "Staged 파일 커밋",
        checkCallback: function (checking) {
            // Don't show this command in command palette, because the
            // commit-smart command is more useful. Still provide this command
            // for hotkeys and automation.
            if (checking) return false;

            plugin.promiseQueue.addTask(async () => {
                return plugin.commit({
                    fromAuto: false,
                    requestCustomMessage: false,
                });
            });
        },
    });

    if (Platform.isDesktopApp) {
        plugin.addCommand({
            id: "commit-amend-staged-specified-message",
            name: "Staged 파일로 amend",
            callback: () =>
                plugin.promiseQueue.addTask(() =>
                    plugin.commit({
                        fromAuto: false,
                        requestCustomMessage: true,
                        onlyStaged: true,
                        amend: true,
                    })
                ),
        });
    }

    plugin.addCommand({
        id: "commit-smart-specified-message",
        name: "커밋 (메시지 직접 입력)",
        callback: () =>
            plugin.promiseQueue.addTask(async () => {
                const status = await plugin.updateCachedStatus();
                const onlyStaged = status.staged.length > 0;
                return plugin.commit({
                    fromAuto: false,
                    requestCustomMessage: true,
                    onlyStaged: onlyStaged,
                });
            }),
    });

    plugin.addCommand({
        id: "commit-staged-specified-message",
        name: "Staged 파일 커밋 (메시지 직접 입력)",
        checkCallback: function (checking) {
            // Same reason as for commit-staged
            if (checking) return false;
            return plugin.promiseQueue.addTask(() =>
                plugin.commit({
                    fromAuto: false,
                    requestCustomMessage: true,
                    onlyStaged: true,
                })
            );
        },
    });

    plugin.addCommand({
        id: "push2",
        name: "Push",
        callback: () => plugin.promiseQueue.addTask(() => plugin.push()),
    });

    plugin.addCommand({
        id: "stage-current-file",
        name: "현재 파일 stage",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) {
                return file !== null;
            } else {
                plugin.promiseQueue.addTask(() => plugin.stageFile(file!));
            }
        },
    });

    plugin.addCommand({
        id: "unstage-current-file",
        name: "현재 파일 unstage",
        checkCallback: (checking) => {
            const file = app.workspace.getActiveFile();
            if (checking) {
                return file !== null;
            } else {
                plugin.promiseQueue.addTask(() => plugin.unstageFile(file!));
            }
        },
    });

    plugin.addCommand({
        id: "edit-remotes",
        name: "원격 편집",
        callback: () =>
            plugin.editRemotes().catch((e) => plugin.displayError(e)),
    });

    plugin.addCommand({
        id: "remove-remote",
        name: "원격 제거",
        callback: () =>
            plugin.removeRemote().catch((e) => plugin.displayError(e)),
    });

    plugin.addCommand({
        id: "set-upstream-branch",
        name: "Upstream 브랜치 설정",
        callback: () =>
            plugin.setUpstreamBranch().catch((e) => plugin.displayError(e)),
    });

    plugin.addCommand({
        id: "delete-repo",
        name: "⚠ 저장소 삭제",
        callback: async () => {
            const repoExists = await app.vault.adapter.exists(
                `${plugin.settings.basePath}/.git`
            );
            if (repoExists) {
                const modal = new GeneralModal(plugin, {
                    options: ["아니오", "예"],
                    placeholder:
                        "정말로 저장소(.git 디렉토리)를 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.",
                    onlySelection: true,
                });
                const shouldDelete = (await modal.openAndGetResult()) === "예";
                if (shouldDelete) {
                    await app.vault.adapter.rmdir(
                        `${plugin.settings.basePath}/.git`,
                        true
                    );
                    new Notice(
                        "저장소를 삭제했습니다. 플러그인을 다시 로드합니다..."
                    );
                    plugin.unloadPlugin();
                    await plugin.init({ fromReload: true });
                }
            } else {
                new Notice("저장소를 찾을 수 없습니다.");
            }
        },
    });

    plugin.addCommand({
        id: "init-repo",
        name: "새 저장소 초기화",
        callback: () =>
            plugin.createNewRepo().catch((e) => plugin.displayError(e)),
    });

    plugin.addCommand({
        id: "clone-repo",
        name: "원격 저장소 clone",
        callback: () =>
            plugin.cloneNewRepo().catch((e) => plugin.displayError(e)),
    });

    plugin.addCommand({
        id: "list-changed-files",
        name: "변경된 파일 목록 보기",
        callback: async () => {
            if (!(await plugin.isAllInitialized())) return;

            try {
                const status = await plugin.updateCachedStatus();
                if (status.changed.length + status.staged.length > 500) {
                    plugin.displayError("표시할 변경사항이 너무 많습니다.");
                    return;
                }

                new ChangedFilesModal(plugin, status.all).open();
            } catch (e) {
                plugin.displayError(e);
            }
        },
    });

    plugin.addCommand({
        id: "switch-branch",
        name: "브랜치 전환",
        callback: () => {
            plugin.switchBranch().catch((e) => plugin.displayError(e));
        },
    });

    plugin.addCommand({
        id: "create-branch",
        name: "새 브랜치 만들기",
        callback: () => {
            plugin.createBranch().catch((e) => plugin.displayError(e));
        },
    });

    plugin.addCommand({
        id: "delete-branch",
        name: "브랜치 삭제",
        callback: () => {
            plugin.deleteBranch().catch((e) => plugin.displayError(e));
        },
    });

    plugin.addCommand({
        id: "discard-all",
        name: "⚠ 모든 변경 버리기",
        callback: async () => {
            const res = await plugin.discardAll();
            switch (res) {
                case "discard":
                    new Notice(
                        "추적 중인 파일들의 변경사항을 모두 버렸습니다."
                    );
                    break;
                case "delete":
                    new Notice("모든 파일을 버렸습니다.");
                    break;
                case false:
                    break;
                default:
                    assertNever(res);
            }
        },
    });

    plugin.addCommand({
        id: "pause-automatic-routines",
        name: "자동화 일시정지/재개",
        callback: () => {
            const pause = !plugin.localStorage.getPausedAutomatics();
            plugin.localStorage.setPausedAutomatics(pause);
            if (pause) {
                plugin.automaticsManager.unload();
                new Notice(`자동화를 일시정지했습니다.`);
            } else {
                plugin.automaticsManager.reload("commit", "push", "pull");
                new Notice(`자동화를 재개했습니다.`);
            }
        },
    });

    plugin.addCommand({
        id: "raw-command",
        name: "Raw 명령 실행",
        checkCallback: (checking) => {
            const gitManager = plugin.gitManager;
            if (checking) {
                // only available on desktop
                return gitManager instanceof SimpleGit;
            } else {
                plugin.tools
                    .runRawCommand()
                    .catch((e) => plugin.displayError(e));
            }
        },
    });

    plugin.addCommand({
        id: "toggle-line-author-info",
        name: "라인 작성자 정보 토글",
        callback: () =>
            plugin.settingsTab?.configureLineAuthorShowStatus(
                !plugin.settings.lineAuthor.show
            ),
    });

    plugin.addCommand({
        id: "reset-hunk",
        name: "Hunk 되돌리기",
        editorCheckCallback(checking, _, __) {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }

            plugin.hunkActions.resetHunk();
        },
    });

    plugin.addCommand({
        id: "stage-hunk",
        name: "Hunk stage",
        editorCheckCallback: (checking, _, __) => {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }
            plugin.promiseQueue.addTask(() => plugin.hunkActions.stageHunk());
        },
    });

    plugin.addCommand({
        id: "preview-hunk",
        name: "Hunk 미리보기",
        editorCheckCallback: (checking, _, __) => {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }
            const editor = plugin.hunkActions.editor!.editor;
            togglePreviewHunk(editor);
        },
    });

    plugin.addCommand({
        id: "next-hunk",
        name: "다음 hunk로 이동",
        editorCheckCallback: (checking, _, __) => {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }
            plugin.hunkActions.goToHunk("next");
        },
    });

    plugin.addCommand({
        id: "prev-hunk",
        name: "이전 hunk로 이동",
        editorCheckCallback: (checking, _, __) => {
            if (checking) {
                return (
                    plugin.settings.hunks.hunkCommands &&
                    plugin.hunkActions.editor !== undefined
                );
            }
            plugin.hunkActions.goToHunk("prev");
        },
    });
}
