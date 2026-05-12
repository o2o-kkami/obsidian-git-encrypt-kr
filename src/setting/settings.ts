import type { App, RGB, TextComponent } from "obsidian";
import {
    debounce,
    moment,
    Notice,
    Platform,
    PluginSettingTab,
    Setting,
    TextAreaComponent,
} from "obsidian";
import {
    DATE_TIME_FORMAT_SECONDS,
    DEFAULT_GITIGNORE,
    DEFAULT_SETTINGS,
    GIT_LINE_AUTHORING_MOVEMENT_DETECTION_MINIMAL_LENGTH,
} from "src/constants";
import { IsomorphicGit } from "src/gitManager/isomorphicGit";
import { SimpleGit } from "src/gitManager/simpleGit";
import { previewColor } from "src/editor/lineAuthor/lineAuthorProvider";
import type {
    LineAuthorDateTimeFormatOptions,
    LineAuthorDisplay,
    LineAuthorFollowMovement,
    LineAuthorSettings,
    LineAuthorTimezoneOption,
} from "src/editor/lineAuthor/model";
import type ObsidianGit from "src/main";
import type {
    ObsidianGitSettings,
    MergeStrategy,
    ShowAuthorInHistoryView,
    SyncMethod,
} from "src/types";
import { convertToRgb, formatMinutes, rgbToString } from "src/utils";

const FORMAT_STRING_REFERENCE_URL =
    "https://momentjs.com/docs/#/parsing/string-format/";
const LINE_AUTHOR_FEATURE_WIKI_LINK =
    "https://publish.obsidian.md/git-doc/Line+Authoring";

export class ObsidianGitSettingsTab extends PluginSettingTab {
    lineAuthorColorSettings: Map<"oldest" | "newest", Setting> = new Map();
    constructor(
        app: App,
        private plugin: ObsidianGit
    ) {
        super(app, plugin);
    }

    icon = "git-pull-request";

    private get settings() {
        return this.plugin.settings;
    }

    display(): void {
        const { containerEl } = this;
        const plugin: ObsidianGit = this.plugin;

        let commitOrSync: string;
        if (plugin.settings.differentIntervalCommitAndPush) {
            commitOrSync = "커밋";
        } else {
            commitOrSync = "커밋 & 동기화";
        }

        const gitReady = plugin.gitReady;

        containerEl.empty();

        // Encryption section is FIRST: if a user enables encryption on a
        // new vault and then keeps scrolling down to configure auto-pull/
        // auto-push intervals, sync would start before the password is
        // entered. Putting it at the top + the lock guard in main.ts work
        // together to make this safe by construction.
        this.addEncryptionSection(this.containerEl);

        // .gitignore editor sits right next to the encryption section: a
        // user setting up an encrypted vault on a new device typically
        // wants to curate the ignore-list at the same time (and before
        // any auto-commit-and-sync settings below could fire).
        this.addGitignoreSection(this.containerEl);

        if (!gitReady) {
            containerEl.createEl("p", {
                text: "Git이 아직 준비되지 않았습니다. 모든 설정을 올바르게 맞추면 커밋·동기화 등을 구성할 수 있습니다.",
            });
            containerEl.createEl("br");
        }

        let setting: Setting;
        if (gitReady) {
            new Setting(containerEl).setName("자동화").setHeading();
            new Setting(containerEl)
                .setName("커밋과 동기화에 별도의 타이머 사용")
                .setDesc(
                    "활성화하면 커밋 간격과 동기화 간격을 따로 설정할 수 있습니다."
                )
                .addToggle((toggle) =>
                    toggle
                        .setValue(
                            plugin.settings.differentIntervalCommitAndPush
                        )
                        .onChange(async (value) => {
                            plugin.settings.differentIntervalCommitAndPush =
                                value;
                            await plugin.saveSettings();
                            plugin.automaticsManager.reload("commit", "push");
                            this.refreshDisplayWithDelay();
                        })
                );

            new Setting(containerEl)
                .setName(`자동 ${commitOrSync} 간격 (분)`)
                .setDesc(
                    `${
                        plugin.settings.differentIntervalCommitAndPush
                            ? "커밋"
                            : "커밋 & 동기화"
                    }을 X분마다 수행합니다. 0 (기본값)으로 설정하면 비활성화됩니다. (자세한 설정은 아래 항목 참조!)`
                )
                .addText((text) => {
                    text.inputEl.type = "number";
                    this.setNonDefaultValue({
                        text,
                        settingsProperty: "autoSaveInterval",
                    });
                    text.setPlaceholder(
                        String(DEFAULT_SETTINGS.autoSaveInterval)
                    );
                    text.onChange(async (value) => {
                        if (value !== "") {
                            plugin.settings.autoSaveInterval = Number(value);
                        } else {
                            plugin.settings.autoSaveInterval =
                                DEFAULT_SETTINGS.autoSaveInterval;
                        }
                        await plugin.saveSettings();
                        plugin.automaticsManager.reload("commit");
                    });
                });

            setting = new Setting(containerEl)
                .setName(`파일 편집 멈춘 뒤 자동 ${commitOrSync}`)
                .setDesc(
                    `${commitOrSync} 간격이 0이 아니어야 합니다.
                        활성화하면 파일 편집을 멈춘 뒤 ${formatMinutes(
                            plugin.settings.autoSaveInterval
                        )}마다 자동 ${commitOrSync}을 실행합니다.
                        편집 중에는 자동 ${commitOrSync}이 실행되지 않습니다. 비활성화하면 마지막 편집 시점과 무관하게 동작합니다.`
                )
                .addToggle((toggle) =>
                    toggle
                        .setValue(plugin.settings.autoBackupAfterFileChange)
                        .onChange(async (value) => {
                            plugin.settings.autoBackupAfterFileChange = value;
                            this.refreshDisplayWithDelay();

                            await plugin.saveSettings();
                            plugin.automaticsManager.reload("commit");
                        })
                );
            this.mayDisableSetting(
                setting,
                plugin.settings.setLastSaveToLastCommit
            );

            setting = new Setting(containerEl)
                .setName(`최근 커밋 기준으로 자동 ${commitOrSync} 시각 갱신`)
                .setDesc(
                    `활성화하면 자동 ${commitOrSync}의 기준 시각을 최근 커밋 시각으로 설정합니다. 수동 커밋을 자주 할 때 자동 ${commitOrSync} 빈도를 줄여줍니다.`
                )
                .addToggle((toggle) =>
                    toggle
                        .setValue(plugin.settings.setLastSaveToLastCommit)
                        .onChange(async (value) => {
                            plugin.settings.setLastSaveToLastCommit = value;
                            await plugin.saveSettings();
                            plugin.automaticsManager.reload("commit");
                            this.refreshDisplayWithDelay();
                        })
                );
            this.mayDisableSetting(
                setting,
                plugin.settings.autoBackupAfterFileChange
            );

            setting = new Setting(containerEl)
                .setName(`자동 push 간격 (분)`)
                .setDesc(
                    "X분마다 커밋을 push합니다. 0 (기본값)으로 설정하면 비활성화됩니다."
                )
                .addText((text) => {
                    text.inputEl.type = "number";
                    this.setNonDefaultValue({
                        text,
                        settingsProperty: "autoPushInterval",
                    });
                    text.setPlaceholder(
                        String(DEFAULT_SETTINGS.autoPushInterval)
                    );
                    text.onChange(async (value) => {
                        if (value !== "") {
                            plugin.settings.autoPushInterval = Number(value);
                        } else {
                            plugin.settings.autoPushInterval =
                                DEFAULT_SETTINGS.autoPushInterval;
                        }
                        await plugin.saveSettings();
                        plugin.automaticsManager.reload("push");
                    });
                });
            this.mayDisableSetting(
                setting,
                !plugin.settings.differentIntervalCommitAndPush
            );

            new Setting(containerEl)
                .setName("자동 pull 간격 (분)")
                .setDesc(
                    "X분마다 변경사항을 pull합니다. 0 (기본값)으로 설정하면 비활성화됩니다."
                )
                .addText((text) => {
                    text.inputEl.type = "number";
                    this.setNonDefaultValue({
                        text,
                        settingsProperty: "autoPullInterval",
                    });
                    text.setPlaceholder(
                        String(DEFAULT_SETTINGS.autoPullInterval)
                    );
                    text.onChange(async (value) => {
                        if (value !== "") {
                            plugin.settings.autoPullInterval = Number(value);
                        } else {
                            plugin.settings.autoPullInterval =
                                DEFAULT_SETTINGS.autoPullInterval;
                        }
                        await plugin.saveSettings();
                        plugin.automaticsManager.reload("pull");
                    });
                });

            new Setting(containerEl)
                .setName(`자동 ${commitOrSync} 시 staged 파일만 커밋`)
                .setDesc(
                    `활성화하면 ${commitOrSync} 시 staged된 파일만 커밋합니다. 비활성화하면 변경된 모든 파일을 커밋합니다.`
                )
                .addToggle((toggle) =>
                    toggle
                        .setValue(plugin.settings.autoCommitOnlyStaged)
                        .onChange(async (value) => {
                            plugin.settings.autoCommitOnlyStaged = value;
                            await plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName(`자동 ${commitOrSync} 시 커밋 메시지 직접 입력`)
                .setDesc("매번 메시지를 입력하라는 팝업이 나타납니다.")
                .addToggle((toggle) =>
                    toggle
                        .setValue(plugin.settings.customMessageOnAutoBackup)
                        .onChange(async (value) => {
                            plugin.settings.customMessageOnAutoBackup = value;
                            await plugin.saveSettings();
                            this.refreshDisplayWithDelay();
                        })
                );

            setting = new Setting(containerEl)
                .setName(`자동 ${commitOrSync} 커밋 메시지`)
                .setDesc(
                    "사용 가능한 placeholder: {{date}}" +
                        " (아래 참조), {{hostname}} (아래 참조), {{numFiles}} (커밋된 변경 파일 수), {{files}} (커밋된 변경 파일 목록)."
                )
                .addTextArea((text) => {
                    text.setPlaceholder(
                        DEFAULT_SETTINGS.autoCommitMessage
                    ).onChange(async (value) => {
                        if (value === "") {
                            plugin.settings.autoCommitMessage =
                                DEFAULT_SETTINGS.autoCommitMessage;
                        } else {
                            plugin.settings.autoCommitMessage = value;
                        }
                        await plugin.saveSettings();
                    });
                    this.setNonDefaultValue({
                        text,
                        settingsProperty: "autoCommitMessage",
                    });
                });
            this.mayDisableSetting(
                setting,
                plugin.settings.customMessageOnAutoBackup
            );

            new Setting(containerEl).setName("커밋 메시지").setHeading();

            const manualCommitMessageSetting = new Setting(containerEl)
                .setName("수동 커밋 시 커밋 메시지")
                .setDesc(
                    "사용 가능한 placeholder: {{date}}" +
                        " (아래 참조), {{hostname}} (아래 참조), {{numFiles}} (커밋된 변경 파일 수), {{files}} (커밋된 변경 파일 목록). 비워두면 매 커밋마다 직접 입력해야 합니다."
                );
            manualCommitMessageSetting.addTextArea((text) => {
                manualCommitMessageSetting.addButton((button) => {
                    button
                        .setIcon("reset")
                        .setTooltip(
                            `기본값으로 설정: "${DEFAULT_SETTINGS.commitMessage}"`
                        )
                        .onClick(() => {
                            text.setValue(DEFAULT_SETTINGS.commitMessage);
                            text.onChanged();
                        });
                });
                text.setValue(plugin.settings.commitMessage);
                text.onChange(async (value) => {
                    plugin.settings.commitMessage = value;
                    await plugin.saveSettings();
                });
            });

            if (Platform.isDesktopApp)
                new Setting(containerEl)
                    .setName("커밋 메시지 스크립트")
                    .setDesc(
                        "커밋 메시지를 생성하기 위해 'sh -c'로 실행되는 스크립트. AI 도구 등으로 커밋 메시지를 자동 생성할 때 사용. 사용 가능한 placeholder: {{hostname}}, {{date}}."
                    )
                    .addText((text) => {
                        text.onChange(async (value) => {
                            if (value === "") {
                                plugin.settings.commitMessageScript =
                                    DEFAULT_SETTINGS.commitMessageScript;
                            } else {
                                plugin.settings.commitMessageScript = value;
                            }
                            await plugin.saveSettings();
                        });
                        this.setNonDefaultValue({
                            text,
                            settingsProperty: "commitMessageScript",
                        });
                    });

            const datePlaceholderSetting = new Setting(containerEl)
                .setName("{{date}} placeholder 포맷")
                .addMomentFormat((text) =>
                    text
                        .setDefaultFormat(plugin.settings.commitDateFormat)
                        .setValue(plugin.settings.commitDateFormat)
                        .onChange(async (value) => {
                            plugin.settings.commitDateFormat = value;
                            await plugin.saveSettings();
                        })
                );

            datePlaceholderSetting.descEl.createSpan({
                text: ` 날짜 포맷을 직접 지정합니다. 예: "${DATE_TIME_FORMAT_SECONDS}". 더 많은 포맷은 `,
            });
            datePlaceholderSetting.descEl.createEl("a", {
                text: "Moment.js 문서",
                href: FORMAT_STRING_REFERENCE_URL,
                attr: {
                    target: "_blank",
                },
            });
            datePlaceholderSetting.descEl.createSpan({
                text: "를 참조하세요.",
            });

            new Setting(containerEl)
                .setName("{{hostname}} placeholder 값")
                .setDesc(
                    "디바이스마다 사용할 hostname을 지정합니다. 데스크탑에서 지정하지 않으면 OS의 hostname이 사용됩니다."
                )
                .addText((text) =>
                    text
                        .setValue(plugin.localStorage.getHostname() ?? "")
                        .onChange((value) => {
                            plugin.localStorage.setHostname(value);
                        })
                );

            new Setting(containerEl)
                .setName("커밋 메시지 미리보기")
                .addButton((button) =>
                    button.setButtonText("미리보기").onClick(async () => {
                        const commitMessagePreview =
                            await plugin.gitManager.formatCommitMessage(
                                plugin.settings.commitMessage
                            );
                        new Notice(`${commitMessagePreview}`);
                    })
                );

            new Setting(containerEl)
                .setName("커밋 본문에 변경된 파일 목록 포함")
                .addToggle((toggle) =>
                    toggle
                        .setValue(plugin.settings.listChangedFilesInMessageBody)
                        .onChange(async (value) => {
                            plugin.settings.listChangedFilesInMessageBody =
                                value;
                            await plugin.saveSettings();
                        })
                );

            new Setting(containerEl).setName("Pull").setHeading();

            if (plugin.gitManager instanceof SimpleGit)
                new Setting(containerEl)
                    .setName("Merge 전략")
                    .setDesc(
                        "원격 브랜치의 커밋을 로컬 브랜치에 통합할 방법을 선택합니다."
                    )
                    .addDropdown((dropdown) => {
                        const options: Record<SyncMethod, string> = {
                            merge: "Merge",
                            rebase: "Rebase",
                            reset: "다른 동기화 서비스 사용 (working directory를 건드리지 않고 HEAD만 갱신)",
                        };
                        dropdown.addOptions(options);
                        dropdown.setValue(plugin.settings.syncMethod);

                        dropdown.onChange(async (option: SyncMethod) => {
                            plugin.settings.syncMethod = option;
                            await plugin.saveSettings();
                        });
                    });

            new Setting(containerEl)
                .setName("충돌 시 merge 전략")
                .setDesc(
                    "원격 변경사항을 pull할 때 충돌을 해결할 방법을 선택합니다. 로컬 또는 원격 변경사항을 자동으로 우선시할 수 있습니다."
                )
                .addDropdown((dropdown) => {
                    const options: Record<MergeStrategy, string> = {
                        none: "None (git 기본)",
                        ours: "내 변경사항 우선",
                        theirs: "원격 변경사항 우선",
                    };
                    dropdown.addOptions(options);
                    dropdown.setValue(plugin.settings.mergeStrategy);

                    dropdown.onChange(async (option: MergeStrategy) => {
                        plugin.settings.mergeStrategy = option;
                        await plugin.saveSettings();
                    });
                });

            new Setting(containerEl)
                .setName("시작 시 자동 pull")
                .setDesc("옵시디언 시작 시 자동으로 커밋을 pull합니다.")
                .addToggle((toggle) =>
                    toggle
                        .setValue(plugin.settings.autoPullOnBoot)
                        .onChange(async (value) => {
                            plugin.settings.autoPullOnBoot = value;
                            await plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName("커밋 & 동기화 (commit-and-sync)")
                .setDesc(
                    "기본 설정의 커밋 & 동기화는 staging → 커밋 → pull → push의 한 번 실행을 의미합니다. 로컬과 원격 저장소를 동기화하기 위해 정기적으로 수행하는 단일 액션입니다."
                )
                .setHeading();

            setting = new Setting(containerEl)
                .setName("커밋 & 동기화 시 push")
                .setDesc(
                    `보통 커밋 후 push까지 합니다. 끄면 ${plugin.settings.pullBeforePush ? "커밋 + pull " : "커밋 "}만 수행하지만 동작 이름은 그대로 "커밋 & 동기화"입니다.`
                )
                .addToggle((toggle) =>
                    toggle
                        .setValue(!plugin.settings.disablePush)
                        .onChange(async (value) => {
                            plugin.settings.disablePush = !value;
                            this.refreshDisplayWithDelay();
                            await plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName("커밋 & 동기화 시 pull")
                .setDesc(
                    `커밋 & 동기화 시 pull도 함께 수행합니다. 끄면 ${plugin.settings.disablePush ? "커밋 " : "커밋 + push "}만 수행합니다.`
                )
                .addToggle((toggle) =>
                    toggle
                        .setValue(plugin.settings.pullBeforePush)
                        .onChange(async (value) => {
                            plugin.settings.pullBeforePush = value;
                            this.refreshDisplayWithDelay();
                            await plugin.saveSettings();
                        })
                );

            if (plugin.gitManager instanceof SimpleGit) {
                new Setting(containerEl)
                    .setName("Hunk 관리")
                    .setDesc(
                        "Hunk는 편집기에서 묶인 라인 변경 단위를 의미합니다."
                    )
                    .setHeading();

                new Setting(containerEl)
                    .setName("표시(Signs)")
                    .setDesc(
                        "편집기에서 변경사항을 컬러 마커로 표시하고 개별 hunk를 stage/reset/미리보기 할 수 있게 합니다."
                    )
                    .addToggle((toggle) =>
                        toggle
                            .setValue(plugin.settings.hunks.showSigns)
                            .onChange(async (value) => {
                                plugin.settings.hunks.showSigns = value;
                                await plugin.saveSettings();
                                plugin.editorIntegration.refreshSignsSettings();
                            })
                    );

                new Setting(containerEl)
                    .setName("Hunk 커맨드")
                    .setDesc(
                        "개별 git diff hunk를 stage/reset하고 'Go to next/prev hunk' 커맨드로 이동할 수 있게 합니다."
                    )
                    .addToggle((toggle) =>
                        toggle
                            .setValue(plugin.settings.hunks.hunkCommands)
                            .onChange(async (value) => {
                                plugin.settings.hunks.hunkCommands = value;
                                await plugin.saveSettings();

                                plugin.editorIntegration.refreshSignsSettings();
                            })
                    );

                new Setting(containerEl)
                    .setName("상태표시줄에 라인 변경 요약 표시")
                    .addDropdown((toggle) =>
                        toggle
                            .addOptions({
                                disabled: "비활성화",
                                colored: "컬러",
                                monochrome: "단색",
                            })
                            .setValue(plugin.settings.hunks.statusBar)
                            .onChange(
                                async (
                                    option: ObsidianGitSettings["hunks"]["statusBar"]
                                ) => {
                                    plugin.settings.hunks.statusBar = option;
                                    await plugin.saveSettings();
                                    plugin.editorIntegration.refreshSignsSettings();
                                }
                            )
                    );

                new Setting(containerEl)
                    .setName("라인 작성자 정보")
                    .setHeading();

                this.addLineAuthorInfoSettings();
            }
        }

        new Setting(containerEl).setName("히스토리 뷰").setHeading();

        new Setting(containerEl)
            .setName("작성자 표시")
            .setDesc("히스토리 뷰에 커밋 작성자를 표시합니다.")
            .addDropdown((dropdown) => {
                const options: Record<ShowAuthorInHistoryView, string> = {
                    hide: "숨김",
                    full: "전체 이름",
                    initials: "이니셜",
                };
                dropdown.addOptions(options);
                dropdown.setValue(plugin.settings.authorInHistoryView);
                dropdown.onChange(async (option: ShowAuthorInHistoryView) => {
                    plugin.settings.authorInHistoryView = option;
                    await plugin.saveSettings();
                    await plugin.refresh();
                });
            });

        new Setting(containerEl)
            .setName("날짜 표시")
            .setDesc(
                "히스토리 뷰에 커밋 날짜를 표시합니다. 날짜 표시 형식은 {{date}} placeholder 포맷을 따릅니다."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.settings.dateInHistoryView)
                    .onChange(async (value) => {
                        plugin.settings.dateInHistoryView = value;
                        await plugin.saveSettings();
                        await plugin.refresh();
                    })
            );

        new Setting(containerEl).setName("소스 컨트롤 뷰").setHeading();

        new Setting(containerEl)
            .setName("파일 변경 시 소스 컨트롤 뷰 자동 새로고침")
            .setDesc(
                "느린 기기에서는 렉을 유발할 수 있습니다. 그럴 경우 이 옵션을 끄세요."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.settings.refreshSourceControl)
                    .onChange(async (value) => {
                        plugin.settings.refreshSourceControl = value;
                        await plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("소스 컨트롤 뷰 새로고침 간격")
            .setDesc(
                "파일 변경 후 소스 컨트롤 뷰를 새로고침하기까지 대기할 시간(밀리초)."
            )
            .addText((text) => {
                const MIN_SOURCE_CONTROL_REFRESH_INTERVAL = 500;
                text.inputEl.type = "number";
                this.setNonDefaultValue({
                    text,
                    settingsProperty: "refreshSourceControlTimer",
                });
                text.setPlaceholder(
                    String(DEFAULT_SETTINGS.refreshSourceControlTimer)
                );
                text.onChange(async (value) => {
                    // Without this check, if the textbox is empty or the input is invalid, MIN_SOURCE_CONTROL_REFRESH_INTERVAL would be saved instead of saving the default value.
                    if (value !== "" && Number.isInteger(Number(value))) {
                        plugin.settings.refreshSourceControlTimer = Math.max(
                            Number(value),
                            MIN_SOURCE_CONTROL_REFRESH_INTERVAL
                        );
                    } else {
                        plugin.settings.refreshSourceControlTimer =
                            DEFAULT_SETTINGS.refreshSourceControlTimer;
                    }
                    await plugin.saveSettings();
                    plugin.setRefreshDebouncer();
                });
            });
        new Setting(containerEl).setName("기타").setHeading();

        if (plugin.gitManager instanceof SimpleGit) {
            new Setting(containerEl)
                .setName("Diff 뷰 스타일")
                .setDesc(
                    'Diff 뷰의 스타일을 설정합니다. "Split" 모드의 diff는 git이 아니라 편집기 자체가 생성하므로 git이 만드는 diff와 다를 수 있습니다. 대신 해당 뷰에서 직접 편집 가능하다는 장점이 있습니다.'
                )
                .addDropdown((dropdown) => {
                    const options: Record<
                        ObsidianGitSettings["diffStyle"],
                        string
                    > = {
                        split: "Split (분할)",
                        git_unified: "Unified (통합)",
                    };
                    dropdown.addOptions(options);
                    dropdown.setValue(plugin.settings.diffStyle);
                    dropdown.onChange(
                        async (option: ObsidianGitSettings["diffStyle"]) => {
                            plugin.settings.diffStyle = option;
                            await plugin.saveSettings();
                        }
                    );
                });
        }

        new Setting(containerEl)
            .setName("일반 알림 끄기")
            .setDesc(
                "git 작업의 정보 알림을 끕니다. 방해를 최소화하기 위함 (상태는 상태표시줄에서 확인)."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.settings.disablePopups)
                    .onChange(async (value) => {
                        plugin.settings.disablePopups = value;
                        this.refreshDisplayWithDelay();
                        await plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("오류 알림 끄기")
            .setDesc(
                "모든 종류의 오류 알림을 끕니다. 방해를 최소화하기 위함 (상태는 상태표시줄에서 확인)."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(!plugin.settings.showErrorNotices)
                    .onChange(async (value) => {
                        plugin.settings.showErrorNotices = !value;
                        await plugin.saveSettings();
                    })
            );

        if (!plugin.settings.disablePopups)
            new Setting(containerEl)
                .setName("변경사항 없을 때 알림 숨기기")
                .setDesc(
                    "커밋이나 push할 변경사항이 없을 때 알림을 표시하지 않습니다."
                )
                .addToggle((toggle) =>
                    toggle
                        .setValue(plugin.settings.disablePopupsForNoChanges)
                        .onChange(async (value) => {
                            plugin.settings.disablePopupsForNoChanges = value;
                            await plugin.saveSettings();
                        })
                );

        new Setting(containerEl)
            .setName("상태표시줄 표시")
            .setDesc("옵시디언을 재시작해야 변경사항이 적용됩니다.")
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.settings.showStatusBar)
                    .onChange(async (value) => {
                        plugin.settings.showStatusBar = value;
                        await plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("파일 메뉴 통합")
            .setDesc(
                `파일 메뉴에 "Stage", "Unstage", ".gitignore에 추가" 액션을 추가합니다.`
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.settings.showFileMenu)
                    .onChange(async (value) => {
                        plugin.settings.showFileMenu = value;
                        await plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("브랜치 상태표시줄 표시")
            .setDesc("옵시디언을 재시작해야 변경사항이 적용됩니다.")
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.settings.showBranchStatusBar)
                    .onChange(async (value) => {
                        plugin.settings.showBranchStatusBar = value;
                        await plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("상태표시줄에 변경된 파일 개수 표시")
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.settings.changedFilesInStatusBar)
                    .onChange(async (value) => {
                        plugin.settings.changedFilesInStatusBar = value;
                        await plugin.saveSettings();
                    })
            );

        if (plugin.gitManager instanceof IsomorphicGit) {
            new Setting(containerEl).setName("인증 / 커밋 작성자").setHeading();
        } else {
            new Setting(containerEl).setName("커밋 작성자").setHeading();
        }

        if (plugin.gitManager instanceof IsomorphicGit)
            new Setting(containerEl)
                .setName("git 서버의 사용자명 (예: GitHub의 username)")
                .addText((cb) => {
                    cb.setValue(plugin.localStorage.getUsername() ?? "");
                    cb.onChange((value) => {
                        plugin.localStorage.setUsername(value);
                    });
                });

        if (plugin.gitManager instanceof IsomorphicGit)
            new Setting(containerEl)
                .setName("비밀번호 / Personal Access Token")
                .setDesc(
                    "비밀번호를 입력하세요. 한 번 저장하면 다시 볼 수 없습니다."
                )
                .addText((cb) => {
                    cb.inputEl.autocapitalize = "off";
                    cb.inputEl.autocomplete = "off";
                    cb.inputEl.spellcheck = false;
                    cb.onChange((value) => {
                        plugin.localStorage.setPassword(value);
                    });
                });

        if (plugin.gitReady)
            new Setting(containerEl)
                .setName("커밋 작성자 이름 (user.name)")
                .addText(async (cb) => {
                    cb.setValue(
                        (await plugin.gitManager.getConfig("user.name")) ?? ""
                    );
                    cb.onChange(async (value) => {
                        await plugin.gitManager.setConfig(
                            "user.name",
                            value == "" ? undefined : value
                        );
                    });
                });

        if (plugin.gitReady)
            new Setting(containerEl)
                .setName("커밋 작성자 이메일 (user.email)")
                .addText(async (cb) => {
                    cb.setValue(
                        (await plugin.gitManager.getConfig("user.email")) ?? ""
                    );
                    cb.onChange(async (value) => {
                        await plugin.gitManager.setConfig(
                            "user.email",
                            value == "" ? undefined : value
                        );
                    });
                });

        new Setting(containerEl)
            .setName("고급")
            .setDesc(
                "일반적으로는 변경할 필요가 없지만 특수한 환경에서 필요할 수 있습니다."
            )
            .setHeading();

        if (plugin.gitManager instanceof SimpleGit) {
            new Setting(containerEl)
                .setName("서브모듈 업데이트")
                .setDesc(
                    '"커밋 & 동기화"와 "pull"이 서브모듈도 처리합니다. 미지원: 충돌 파일, pull/push/커밋된 파일 수 집계. 각 서브모듈에 추적 브랜치(tracking branch)가 설정되어 있어야 합니다.'
                )
                .addToggle((toggle) =>
                    toggle
                        .setValue(plugin.settings.updateSubmodules)
                        .onChange(async (value) => {
                            plugin.settings.updateSubmodules = value;
                            await plugin.saveSettings();
                        })
                );
            if (plugin.settings.updateSubmodules) {
                new Setting(containerEl)
                    .setName("서브모듈 재귀 checkout/switch")
                    .setDesc(
                        "루트 저장소에서 checkout이 일어날 때 서브모듈에도 재귀적으로 checkout을 수행합니다 (해당 브랜치가 존재하는 경우)."
                    )
                    .addToggle((toggle) =>
                        toggle
                            .setValue(plugin.settings.submoduleRecurseCheckout)
                            .onChange(async (value) => {
                                plugin.settings.submoduleRecurseCheckout =
                                    value;
                                await plugin.saveSettings();
                            })
                    );
            }
        }

        if (plugin.gitManager instanceof SimpleGit)
            new Setting(containerEl)
                .setName("git 바이너리 경로 직접 지정")
                .setDesc(
                    "git 실행 파일의 경로를 지정합니다. 보통 PATH에 git이 있어야 하며, 별도 위치에 설치된 git을 쓸 때만 필요합니다."
                )
                .addText((cb) => {
                    cb.setValue(plugin.localStorage.getGitPath() ?? "");
                    cb.setPlaceholder("git");
                    cb.onChange((value) => {
                        plugin.localStorage.setGitPath(value);
                        plugin.gitManager
                            .updateGitPath(value || "git")
                            .catch((e) => plugin.displayError(e));
                    });
                });

        if (plugin.gitManager instanceof SimpleGit)
            new Setting(containerEl)
                .setName("추가 환경변수")
                .setDesc(
                    "한 줄에 하나씩, KEY=VALUE 형식으로 환경변수를 입력합니다."
                )
                .addTextArea((cb) => {
                    cb.setPlaceholder("GIT_DIR=/path/to/git/dir");
                    cb.setValue(plugin.localStorage.getEnvVars().join("\n"));
                    cb.onChange((value) => {
                        plugin.localStorage.setEnvVars(value.split("\n"));
                    });
                });

        if (plugin.gitManager instanceof SimpleGit)
            new Setting(containerEl)
                .setName("PATH 환경변수에 추가할 경로")
                .setDesc("한 줄에 하나씩 경로를 입력합니다.")
                .addTextArea((cb) => {
                    cb.setValue(plugin.localStorage.getPATHPaths().join("\n"));
                    cb.onChange((value) => {
                        plugin.localStorage.setPATHPaths(value.split("\n"));
                    });
                });
        if (plugin.gitManager instanceof SimpleGit)
            new Setting(containerEl)
                .setName("새 환경변수로 다시 로드")
                .setDesc(
                    "이전에 추가했던 환경변수를 제거한 경우, 옵시디언을 재시작해야 반영됩니다."
                )
                .addButton((cb) => {
                    cb.setButtonText("다시 로드");
                    cb.setCta();
                    cb.onClick(async () => {
                        await (plugin.gitManager as SimpleGit).setGitInstance();
                    });
                });

        new Setting(containerEl)
            .setName("기본 경로 직접 지정 (git 저장소 경로)")
            .setDesc(
                `
            git 바이너리가 실행될 vault 내부의 상대 경로를 지정합니다.
            git 저장소가 vault 루트가 아닌 하위 디렉토리에 있을 때 필요합니다. Windows에서는 "/" 대신 "\\"를 사용하세요.
            `
            )
            .addText((cb) => {
                cb.setValue(plugin.settings.basePath);
                cb.setPlaceholder("directory/directory-with-git-repo");
                cb.onChange(async (value) => {
                    plugin.settings.basePath = value;
                    await plugin.saveSettings();
                    plugin.gitManager
                        .updateBasePath(value || "")
                        .catch((e) => plugin.displayError(e));
                });
            });

        new Setting(containerEl)
            .setName("git 디렉토리 경로 직접 지정 ('.git' 대신)")
            .setDesc(
                `GIT_DIR 환경변수에 해당합니다. 적용하려면 옵시디언 재시작이 필요합니다. Windows에서는 "/" 대신 "\\"를 사용하세요.`
            )
            .addText((cb) => {
                cb.setValue(plugin.settings.gitDir);
                cb.setPlaceholder(".git");
                cb.onChange(async (value) => {
                    plugin.settings.gitDir = value;
                    await plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("이 디바이스에서 비활성화")
            .setDesc(
                "이 디바이스에서만 플러그인을 비활성화합니다. 이 설정은 동기화되지 않습니다."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(plugin.localStorage.getPluginDisabled())
                    .onChange((value) => {
                        plugin.localStorage.setPluginDisabled(value);
                        if (value) {
                            plugin.unloadPlugin();
                        } else {
                            plugin
                                .init({ fromReload: true })
                                .catch((e) => plugin.displayError(e));
                        }
                        new Notice(
                            "옵시디언을 재시작해야 변경사항이 적용됩니다."
                        );
                    })
            );

        new Setting(containerEl).setName("지원").setHeading();
        new Setting(containerEl)
            .setName("후원")
            .setDesc(
                "이 플러그인이 마음에 들었다면 개발 지속을 위한 후원을 고려해 주세요."
            )
            .addButton((bt) => {
                const link = bt.buttonEl.parentElement?.createEl("a", {
                    href: "https://ko-fi.com/F1F195IQ5",
                    attr: {
                        target: "_blank",
                    },
                });
                if (link) {
                    link.createEl("img", {
                        attr: {
                            height: "36",
                            style: "border:0px;height:36px;",
                            src: "https://cdn.ko-fi.com/cdn/kofi3.png?v=3",
                            border: "0",
                            alt: "Buy Me a Coffee at ko-fi.com",
                        },
                    });
                    bt.buttonEl.remove();
                }
            });

        const debugDiv = containerEl.createDiv();
        debugDiv.setAttr("align", "center");
        debugDiv.setAttr("style", "margin: var(--size-4-2)");

        const debugButton = debugDiv.createEl("button");
        debugButton.setText("디버그 정보 복사");
        debugButton.onclick = async () => {
            await window.navigator.clipboard.writeText(
                JSON.stringify(
                    {
                        settings: this.plugin.settings,
                        pluginVersion: this.plugin.manifest.version,
                    },
                    null,
                    4
                )
            );
            new Notice(
                "디버그 정보를 클립보드에 복사했습니다. 민감한 정보가 포함되어 있을 수 있습니다!"
            );
        };

        if (Platform.isDesktopApp) {
            const info = containerEl.createDiv();
            info.setAttr("align", "center");
            info.setText(
                "디버깅과 로그 확인:\n이 플러그인 및 다른 플러그인의 로그를 보려면 콘솔을 여세요"
            );
            const keys = containerEl.createDiv();
            keys.setAttr("align", "center");
            keys.addClass("obsidian-git-shortcuts");
            if (Platform.isMacOS === true) {
                keys.createEl("kbd", { text: "CMD (⌘) + OPTION (⌥) + I" });
            } else {
                keys.createEl("kbd", { text: "CTRL + SHIFT + I" });
            }
        }

        // (Encryption and .gitignore sections are now rendered at the
        // TOP of display() so users see them before scrolling into
        // sync-related settings.)
    }

    mayDisableSetting(setting: Setting, disable: boolean) {
        if (disable) {
            setting.setDisabled(disable);
            setting.setClass("obsidian-git-disabled");
        }
    }

    public configureLineAuthorShowStatus(show: boolean) {
        this.settings.lineAuthor.show = show;
        void this.plugin.saveSettings();

        if (show) this.plugin.editorIntegration.activateLineAuthoring();
        else this.plugin.editorIntegration.deactiveLineAuthoring();
    }

    /**
     * Persists the setting {@link key} with value {@link value} and
     * refreshes the line author info views.
     */
    public async lineAuthorSettingHandler<
        K extends keyof ObsidianGitSettings["lineAuthor"],
    >(key: K, value: ObsidianGitSettings["lineAuthor"][K]): Promise<void> {
        this.settings.lineAuthor[key] = value;
        await this.plugin.saveSettings();
        this.plugin.editorIntegration.lineAuthoringFeature.refreshLineAuthorViews();
    }

    /**
     * Ensure, that certain last shown values are persistent in the settings.
     *
     * Necessary for the line author info gutter context menus.
     */
    public beforeSaveSettings() {
        const laSettings = this.settings.lineAuthor;
        if (laSettings.authorDisplay !== "hide") {
            laSettings.lastShownAuthorDisplay = laSettings.authorDisplay;
        }
        if (laSettings.dateTimeFormatOptions !== "hide") {
            laSettings.lastShownDateTimeFormatOptions =
                laSettings.dateTimeFormatOptions;
        }
    }

    private addLineAuthorInfoSettings() {
        const baseLineAuthorInfoSetting = new Setting(this.containerEl).setName(
            "각 라인 옆에 커밋 작성 정보 표시"
        );

        if (
            !this.plugin.editorIntegration.lineAuthoringFeature.isAvailableOnCurrentPlatform()
        ) {
            baseLineAuthorInfoSetting
                .setDesc("현재 데스크탑에서만 사용 가능합니다.")
                .setDisabled(true);
        }

        baseLineAuthorInfoSetting.descEl.createEl("a", {
            href: LINE_AUTHOR_FEATURE_WIKI_LINK,
            text: "기능 가이드 및 예시",
            attr: {
                target: "_blank",
            },
        });
        baseLineAuthorInfoSetting.descEl.createEl("br");
        baseLineAuthorInfoSetting.descEl.createSpan({
            text: " 커밋 해시, 작성자 이름, 작성 날짜를 각각 개별 토글할 수 있습니다.",
        });
        baseLineAuthorInfoSetting.descEl.createEl("br");
        baseLineAuthorInfoSetting.descEl.createSpan({
            text: "모두 숨기면 나이별 컬러 사이드바만 표시됩니다.",
        });

        baseLineAuthorInfoSetting.addToggle((toggle) =>
            toggle.setValue(this.settings.lineAuthor.show).onChange((value) => {
                this.configureLineAuthorShowStatus(value);
                this.refreshDisplayWithDelay();
            })
        );

        if (this.settings.lineAuthor.show) {
            const trackMovement = new Setting(this.containerEl)
                .setName("파일·커밋 간 라인 이동/복사 추적")
                .addDropdown((dropdown) => {
                    dropdown.addOptions(<
                        Record<LineAuthorFollowMovement, string>
                    >{
                        inactive: "추적 안 함 (기본)",
                        "same-commit": "같은 커밋 내에서 추적",
                        "all-commits": "모든 커밋에서 추적 (느릴 수 있음)",
                    });
                    dropdown.setValue(this.settings.lineAuthor.followMovement);
                    dropdown.onChange((value: LineAuthorFollowMovement) =>
                        this.lineAuthorSettingHandler("followMovement", value)
                    );
                });

            trackMovement.descEl.createSpan({
                text: "기본 (비활성)에서는 각 라인이 마지막으로 변경된 가장 최근 커밋만 표시합니다.",
            });
            trackMovement.descEl.createEl("br");
            trackMovement.descEl.createEl("i", { text: "같은 커밋 내 추적" });
            trackMovement.descEl.createSpan({
                text: ": 같은 커밋 안의 잘라내기-복사-붙여넣기를 추적하여 원본 작성 커밋을 표시합니다.",
            });
            trackMovement.descEl.createEl("br");
            trackMovement.descEl.createEl("i", { text: "모든 커밋에서 추적" });
            trackMovement.descEl.createSpan({
                text: ": 여러 커밋 사이의 잘라내기-복사-붙여넣기도 감지합니다.",
            });
            trackMovement.descEl.createEl("br");
            trackMovement.descEl.createSpan({ text: "내부적으로 " });
            trackMovement.descEl.createEl("a", {
                href: "https://git-scm.com/docs/git-blame",
                text: "git-blame",
                attr: {
                    target: "_blank",
                },
            });
            trackMovement.descEl.createSpan({
                text: `을 사용하며, 같은 (또는 모든) 커밋 내에서 최소 ${GIT_LINE_AUTHORING_MOVEMENT_DETECTION_MINIMAL_LENGTH}자 이상 일치할 때 `,
            });
            trackMovement.descEl.createEl("em", { text: "원본 작성" });
            trackMovement.descEl.createSpan({
                text: " 커밋 정보를 표시합니다.",
            });

            new Setting(this.containerEl)
                .setName("커밋 해시 표시")
                .addToggle((tgl) => {
                    tgl.setValue(this.settings.lineAuthor.showCommitHash);
                    tgl.onChange((value: boolean) =>
                        this.lineAuthorSettingHandler("showCommitHash", value)
                    );
                });

            new Setting(this.containerEl)
                .setName("작성자 이름 표시")
                .setDesc("작성자 이름의 표시 형식")
                .addDropdown((dropdown) => {
                    const options: Record<LineAuthorDisplay, string> = {
                        hide: "숨김",
                        initials: "이니셜 (기본)",
                        "first name": "이름(first)",
                        "last name": "성(last)",
                        full: "전체 이름",
                    };
                    dropdown.addOptions(options);
                    dropdown.setValue(this.settings.lineAuthor.authorDisplay);

                    dropdown.onChange(async (value: LineAuthorDisplay) =>
                        this.lineAuthorSettingHandler("authorDisplay", value)
                    );
                });

            new Setting(this.containerEl)
                .setName("작성 날짜 표시")
                .setDesc("라인 작성 일시의 표시 형식")
                .addDropdown((dropdown) => {
                    const options: Record<
                        LineAuthorDateTimeFormatOptions,
                        string
                    > = {
                        hide: "숨김",
                        date: "날짜 (기본)",
                        datetime: "날짜 + 시간",
                        "natural language": "자연어",
                        custom: "사용자 지정",
                    };
                    dropdown.addOptions(options);
                    dropdown.setValue(
                        this.settings.lineAuthor.dateTimeFormatOptions
                    );

                    dropdown.onChange(
                        async (value: LineAuthorDateTimeFormatOptions) => {
                            await this.lineAuthorSettingHandler(
                                "dateTimeFormatOptions",
                                value
                            );
                            this.refreshDisplayWithDelay();
                        }
                    );
                });

            if (this.settings.lineAuthor.dateTimeFormatOptions === "custom") {
                const dateTimeFormatCustomStringSetting = new Setting(
                    this.containerEl
                );

                dateTimeFormatCustomStringSetting
                    .setName("작성 날짜 사용자 지정 포맷")
                    .addText((cb) => {
                        cb.setValue(
                            this.settings.lineAuthor.dateTimeFormatCustomString
                        );
                        cb.setPlaceholder("YYYY-MM-DD HH:mm");

                        cb.onChange(async (value) => {
                            await this.lineAuthorSettingHandler(
                                "dateTimeFormatCustomString",
                                value
                            );
                            this.setCustomDateTimeDescription(
                                dateTimeFormatCustomStringSetting.descEl,
                                value
                            );
                        });
                    });

                this.setCustomDateTimeDescription(
                    dateTimeFormatCustomStringSetting.descEl,
                    this.settings.lineAuthor.dateTimeFormatCustomString
                );
            }

            const timezoneSetting = new Setting(this.containerEl)
                .setName("작성 날짜 표시 시간대")
                .addDropdown((dropdown) => {
                    const options: Record<LineAuthorTimezoneOption, string> = {
                        "viewer-local": "내 로컬 시간대 (기본)",
                        "author-local": "작성자의 로컬 시간대",
                        utc0000: "UTC+0000/Z",
                    };
                    dropdown.addOptions(options);
                    dropdown.setValue(
                        this.settings.lineAuthor.dateTimeTimezone
                    );

                    dropdown.onChange(async (value: LineAuthorTimezoneOption) =>
                        this.lineAuthorSettingHandler("dateTimeTimezone", value)
                    );
                });
            timezoneSetting.descEl.empty();
            timezoneSetting.descEl.createSpan({
                text: "작성 날짜를 표시할 시간대.\n내 로컬 시간대(기본), 커밋 작성 당시 작성자의 로컬 시간대, 또는\n",
            });
            timezoneSetting.descEl.createEl("a", {
                text: "UTC±00:00",
                href: "https://en.wikipedia.org/wiki/UTC%C2%B100:00",
            });
            timezoneSetting.descEl.createSpan({
                text: ".",
            });

            const oldestAgeSetting = new Setting(this.containerEl).setName(
                "컬러링에 사용할 최대 나이"
            );

            this.setOldestAgeDescription(
                oldestAgeSetting.descEl,
                this.settings.lineAuthor.coloringMaxAge
            );

            oldestAgeSetting.addText((text) => {
                text.setPlaceholder("1y");
                text.setValue(this.settings.lineAuthor.coloringMaxAge);
                text.onChange(async (value) => {
                    const duration = parseColoringMaxAgeDuration(value);
                    const valid = duration !== undefined;
                    this.setOldestAgeDescription(
                        oldestAgeSetting.descEl,
                        value
                    );
                    if (valid) {
                        await this.lineAuthorSettingHandler(
                            "coloringMaxAge",
                            value
                        );
                        this.refreshColorSettingsName("oldest");
                    }
                });
            });

            this.createColorSetting("newest");
            this.createColorSetting("oldest");

            const textColorSetting = new Setting(this.containerEl)
                .setName("텍스트 색상")
                .addText((field) => {
                    field.setValue(this.settings.lineAuthor.textColorCss);
                    field.onChange(async (value) => {
                        await this.lineAuthorSettingHandler(
                            "textColorCss",
                            value
                        );
                    });
                });
            textColorSetting.descEl.empty();
            textColorSetting.descEl.createSpan({
                text: "거터 텍스트의 CSS 색상.",
            });
            textColorSetting.descEl.createEl("br");
            textColorSetting.descEl.createEl("br");
            textColorSetting.descEl.createSpan({
                text: "테마가 정의한 ",
            });
            textColorSetting.descEl.createEl("a", {
                text: "CSS 변수",
                href: "https://developer.mozilla.org/ko/docs/Web/CSS/Using_CSS_custom_properties",
            });
            textColorSetting.descEl.createSpan({
                text: " 사용을 강력히 권장합니다 (예: ",
            });
            textColorSetting.descEl.createEl("pre", {
                text: "var(--text-muted)",
                attr: {
                    style: "display:inline",
                },
            });
            textColorSetting.descEl.createSpan({ text: " 또는 " });
            textColorSetting.descEl.createEl("pre", {
                text: "var(--text-on-accent)",
                attr: {
                    style: "display:inline",
                },
            });
            textColorSetting.descEl.createSpan({
                text: "). 테마 변경에 자동으로 적응합니다.",
            });
            textColorSetting.descEl.createEl("br");
            textColorSetting.descEl.createEl("br");
            textColorSetting.descEl.createSpan({ text: "참고: " });
            textColorSetting.descEl.createEl("a", {
                text: "Obsidian에서 사용 가능한 CSS 변수 목록",
                href: "https://github.com/obsidian-community/obsidian-theme-template/blob/main/obsidian.css",
            });

            const ignoreWhitespaceSetting = new Setting(this.containerEl)
                .setName("변경사항에서 공백·개행 무시")
                .addToggle((tgl) => {
                    tgl.setValue(this.settings.lineAuthor.ignoreWhitespace);
                    tgl.onChange((value) =>
                        this.lineAuthorSettingHandler("ignoreWhitespace", value)
                    );
                });
            ignoreWhitespaceSetting.descEl.empty();
            ignoreWhitespaceSetting.descEl.createSpan({
                text: "기본값에서는 공백과 개행도 문서·변경의 일부로 간주됩니다(=무시하지 않음). 그래서 새 줄이 추가되면 이전 마지막 줄이 텍스트가 같더라도 '변경됨'으로 표시됩니다.",
            });
            ignoreWhitespaceSetting.descEl.createEl("br");
            ignoreWhitespaceSetting.descEl.createSpan({
                text: "순수 공백 변경(예: 리스트 들여쓰기, 인용 들여쓰기)을 무시하고 싶다면 이 옵션을 활성화하세요. 더 의미 있는 변경 감지가 됩니다.",
            });
        }
    }

    /**
     * Transparent vault encryption settings — AES-256-GCM at the
     * isomorphic-git filesystem layer. Password is held only in this
     * device's localStorage; salt is a hardcoded plugin constant.
     */
    private addEncryptionSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName("Vault 암호화 (실험적)")
            .setHeading()
            .setDesc(
                createFragment((frag) => {
                    frag.createEl("p", {
                        text: "디바이스를 떠나기 전에 vault의 모든 파일을 암호화합니다. Git 서버에는 ciphertext만 저장되며, 옵시디언 자체는 평문을 보기 때문에 검색·그래프·백링크가 정상 동작합니다.",
                    });
                    frag.createEl("p", {
                        text: "isomorphic-git 모드 전용입니다 (암호화가 켜지면 시스템 git 모드는 자동으로 비활성화됩니다). 비밀번호는 이 디바이스의 localStorage에만 저장되며 어디에도 동기화되지 않습니다. 같은 vault를 복호화하려면 모든 디바이스에서 동일한 비밀번호를 입력해야 합니다.",
                    });
                    frag.createEl("p", {
                        text: "⚠ 비밀번호를 잃으면 vault는 영구적으로 복호화 불가능합니다. 사용 전에 비밀번호 관리자(1Password, Bitwarden 등)에 반드시 백업해 두세요.",
                    });
                })
            );

        new Setting(containerEl)
            .setName("암호화 활성화")
            .setDesc(
                "디바이스마다 독립적으로 토글합니다. 토글 변경 시 자동으로 적용됩니다. 동일한 비밀번호는 어디서든 동일한 키를 생성합니다 (디바이스 간 동기화 상태 없음)."
            )
            .addToggle((tgl) => {
                tgl.setValue(this.plugin.settings.encryption.enabled);
                tgl.onChange(async (value) => {
                    this.plugin.settings.encryption.enabled = value;
                    await this.plugin.saveSettings();
                    try {
                        await this.plugin.init({ fromReload: true });
                        new Notice(
                            value
                                ? "암호화가 활성화되었습니다."
                                : "암호화가 비활성화되었습니다."
                        );
                    } catch (e) {
                        console.error("암호화 토글 적용 실패:", e);
                        new Notice("적용 실패 — 개발자 콘솔을 확인하세요");
                    }
                });
            });

        // Password change re-derives keys (PBKDF2 200k iter is heavy), so
        // debounce the re-init to avoid running it on every keystroke.
        const reinitOnPasswordChange = debounce(
            () => {
                if (!this.plugin.settings.encryption.enabled) return;
                void this.plugin
                    .init({ fromReload: true })
                    .then(() => new Notice("비밀번호가 적용되었습니다."))
                    .catch((e) => {
                        console.error("비밀번호 적용 실패:", e);
                        new Notice("적용 실패 — 개발자 콘솔을 확인하세요");
                    });
            },
            800,
            true
        );

        new Setting(containerEl)
            .setName("암호화 비밀번호")
            .setDesc(
                "이 디바이스의 localStorage에만 저장됩니다. 비워두면 삭제됩니다. 이 vault를 동기화하는 모든 디바이스에서 동일한 값을 입력해야 합니다. 입력 후 잠시 멈추면 자동 적용됩니다."
            )
            .addText((text) => {
                text.inputEl.type = "password";
                text.setPlaceholder("비밀번호");
                const current =
                    this.plugin.localStorage.getEncryptionPassword() ?? "";
                text.setValue(current);
                text.onChange((value) => {
                    if (value) {
                        this.plugin.localStorage.setEncryptionPassword(value);
                    } else {
                        this.plugin.localStorage.clearEncryptionPassword();
                    }
                    reinitOnPasswordChange();
                });
            });
    }

    /**
     * Bind a textarea to the vault's root `.gitignore` file. Reads it on
     * mount (creating it with {@link DEFAULT_GITIGNORE} if missing), writes
     * back on edit (debounced), and offers a button to reset to defaults.
     */
    private addGitignoreSection(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName(".gitignore")
            .setHeading()
            .setDesc(
                "vault 루트의 .gitignore 파일을 직접 편집합니다. 변경사항은 타이핑이 멈춘 뒤 500ms 후 자동 저장됩니다."
            );

        const adapter = this.plugin.app.vault.adapter;
        const gitignorePath = ".gitignore";

        const writeDebounced = debounce(
            (value: string) => {
                void adapter.write(gitignorePath, value);
            },
            500,
            true
        );

        let textArea: TextAreaComponent | undefined;

        new Setting(containerEl)
            .setName(".gitignore 내용")
            .setClass("obsidian-git-gitignore-setting")
            .addTextArea((ta) => {
                textArea = ta;
                ta.inputEl.rows = 12;
                ta.inputEl.style.width = "100%";
                ta.inputEl.style.fontFamily = "var(--font-monospace)";
                ta.setPlaceholder("불러오는 중…");

                void (async () => {
                    try {
                        const exists = await adapter.exists(gitignorePath);
                        if (exists) {
                            // File already exists (created by the user
                            // earlier, or pulled from origin). Just show it.
                            ta.setValue(await adapter.read(gitignorePath));
                        } else {
                            // IMPORTANT: do NOT auto-write DEFAULT_GITIGNORE
                            // here. Doing so on every settings-tab open
                            // would silently dirty the working tree from a
                            // read-only UI action; if the remote has its
                            // own .gitignore (e.g. a shared team vault),
                            // the next auto commit-and-sync would happily
                            // overwrite the remote with our local default.
                            //
                            // Leave the textarea empty and surface an
                            // explicit "기본값으로 재설정" button below
                            // — only an intentional click should write.
                            ta.setValue("");
                            ta.setPlaceholder(
                                "vault에 .gitignore 파일이 없습니다. 아래 '기본값으로 재설정' 버튼을 누르면 안전한 기본값으로 생성됩니다."
                            );
                        }
                    } catch (e) {
                        console.error(".gitignore 불러오기 실패:", e);
                        ta.setPlaceholder(
                            "불러오기 실패 — 개발자 콘솔(Ctrl+Shift+I)을 확인하세요"
                        );
                    }
                })();

                ta.onChange((value) => writeDebounced(value));
            });

        new Setting(containerEl)
            .setName("기본값 불러오기")
            .setDesc("현재 .gitignore 내용을 지우고 기본값으로 덮어씁니다.")
            .addButton((btn) => {
                btn.setButtonText("기본값으로 재설정").onClick(async () => {
                    try {
                        await adapter.write(gitignorePath, DEFAULT_GITIGNORE);
                        textArea?.setValue(DEFAULT_GITIGNORE);
                        new Notice(".gitignore를 기본값으로 재설정했습니다.");
                    } catch (e) {
                        console.error(".gitignore 재설정 실패:", e);
                        new Notice("재설정 실패 — 개발자 콘솔을 확인하세요");
                    }
                });
            });
    }

    private createColorSetting(which: "oldest" | "newest") {
        const setting = new Setting(this.containerEl)
            .setName("")
            .addText((text) => {
                const color = pickColor(which, this.settings.lineAuthor);
                const defaultColor = pickColor(
                    which,
                    DEFAULT_SETTINGS.lineAuthor
                );
                text.setPlaceholder(rgbToString(defaultColor));
                text.setValue(rgbToString(color));
                text.onChange(async (colorNew) => {
                    const rgb = convertToRgb(colorNew);
                    if (rgb !== undefined) {
                        const key =
                            which === "newest" ? "colorNew" : "colorOld";
                        await this.lineAuthorSettingHandler(key, rgb);
                    }
                    this.refreshColorSettingsDesc(which, rgb);
                });
            });
        this.lineAuthorColorSettings.set(which, setting);

        this.refreshColorSettingsName(which);
        this.refreshColorSettingsDesc(
            which,
            pickColor(which, this.settings.lineAuthor)
        );
    }

    private refreshColorSettingsName(which: "oldest" | "newest") {
        const settingsDom = this.lineAuthorColorSettings.get(which);
        if (settingsDom) {
            const whichDescriber =
                which === "oldest"
                    ? `oldest (${this.settings.lineAuthor.coloringMaxAge} or older)`
                    : "newest";
            settingsDom.nameEl.setText(`Color for ${whichDescriber} commits`);
        }
    }

    private refreshColorSettingsDesc(which: "oldest" | "newest", rgb?: RGB) {
        const settingsDom = this.lineAuthorColorSettings.get(which);
        if (settingsDom) {
            this.colorSettingPreviewDesc(
                settingsDom.descEl,
                which,
                this.settings.lineAuthor,
                rgb !== undefined
            );
        }
    }

    private colorSettingPreviewDesc(
        descEl: HTMLElement,
        which: "oldest" | "newest",
        laSettings: LineAuthorSettings,
        colorIsValid: boolean
    ): void {
        descEl.empty();
        descEl.createSpan({
            text: "Supports 'rgb(r,g,b)', 'hsl(h,s,l)', hex (#) and named colors (e.g. 'black', 'purple'). Color preview: ",
        });

        const rgbStr = colorIsValid
            ? previewColor(which, laSettings)
            : `rgba(127,127,127,0.3)`;
        const today = moment.unix(moment.now() / 1000).format("YYYY-MM-DD");
        const text = colorIsValid
            ? `abcdef Author Name ${today}`
            : "invalid color";

        descEl.createEl("div", {
            text: text,
            attr: {
                class: "line-author-settings-preview",
                style: `background-color: ${rgbStr}; width: 30ch;`,
            },
        });
    }

    private setCustomDateTimeDescription(
        descEl: HTMLElement,
        dateTimeFormatCustomString: string
    ): void {
        descEl.empty();
        descEl.createEl("a", {
            text: "Format string",
            href: FORMAT_STRING_REFERENCE_URL,
        });
        descEl.createSpan({
            text: " to display the authoring date.",
        });
        descEl.createEl("br");
        const formattedDateTime = moment().format(dateTimeFormatCustomString);
        descEl.createSpan({
            text: `Currently: ${formattedDateTime}`,
        });
    }

    private setOldestAgeDescription(
        descEl: HTMLElement,
        coloringMaxAge: string
    ): void {
        const duration = parseColoringMaxAgeDuration(coloringMaxAge);
        const durationString =
            duration !== undefined ? `${duration.asDays()} days` : "invalid!";
        descEl.empty();
        descEl.createSpan({
            text: `The oldest age in the line author coloring. Everything older will have the same color.\nSmallest valid age is "1d". Currently: ${durationString}`,
        });
    }

    /**
     * Sets the value in the textbox for a given setting only if the saved value differs from the default value.
     * If the saved value is the default value, it probably wasn't defined by the user, so it's better to display it as a placeholder.
     */
    private setNonDefaultValue({
        settingsProperty,
        text,
    }: {
        settingsProperty: keyof ObsidianGitSettings;
        text: TextComponent | TextAreaComponent;
    }): void {
        const storedValue = this.plugin.settings[settingsProperty];
        const defaultValue = DEFAULT_SETTINGS[settingsProperty];

        if (defaultValue !== storedValue) {
            // Doesn't add "" to saved strings
            if (
                typeof storedValue === "string" ||
                typeof storedValue === "number" ||
                typeof storedValue === "boolean"
            ) {
                text.setValue(String(storedValue));
            } else {
                text.setValue(JSON.stringify(storedValue));
            }
        }
    }

    /**
     * Delays the update of the settings UI.
     * Used when the user toggles one of the settings that control enabled states of other settings. Delaying the update
     * allows most of the toggle animation to run, instead of abruptly jumping between enabled/disabled states.
     */
    private refreshDisplayWithDelay(timeout = 80): void {
        setTimeout(() => this.display(), timeout);
    }
}

export function pickColor(
    which: "oldest" | "newest",
    las: LineAuthorSettings
): RGB {
    return which === "oldest" ? las.colorOld : las.colorNew;
}

export function parseColoringMaxAgeDuration(
    durationString: string
): moment.Duration | undefined {
    // https://momentjs.com/docs/#/durations/creating/
    const duration = moment.duration("P" + durationString.toUpperCase());
    return duration.isValid() && duration.asDays() && duration.asDays() >= 1
        ? duration
        : undefined;
}
