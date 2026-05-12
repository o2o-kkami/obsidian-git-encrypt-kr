import type { App } from "obsidian";
import { Modal, Notice, Setting } from "obsidian";

/**
 * Result of {@link AuthorInfoModal}.
 *
 *  - `input`:  사용자가 이름·이메일을 입력하고 "확인"을 눌렀음
 *  - `skip`:   "건너뛰기 (Anonymous 사용)"를 눌렀음 — caller가 dummy
 *              author로 .git/config를 채워야 함
 *  - `cancel`: modal을 그냥 닫았음(Esc, 바깥 클릭 등) — caller가 어떻게
 *              할지 결정. 일반적으로 "다음 init에 다시 묻기"가 안전.
 */
export type AuthorInfoResult =
    | { kind: "input"; name: string; email: string }
    | { kind: "skip" }
    | { kind: "cancel" };

/**
 * Onboarding modal that asks the user for `user.name` / `user.email`
 * once when the plugin first sees a valid repo without them set.
 *
 * Encryption-fork rationale: `git commit` requires both fields; the
 * upstream behavior of erroring out at first commit time (and forcing
 * the user to go hunt the settings tab) is bad UX. We prompt up
 * front, accept a "skip" that falls back to Anonymous, and let the
 * caller persist the result.
 */
export class AuthorInfoModal extends Modal {
    private inputName = "";
    private inputEmail = "";
    private result: AuthorInfoResult = { kind: "cancel" };
    private resolveFn: ((r: AuthorInfoResult) => void) | undefined;

    constructor(app: App) {
        super(app);
    }

    override onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("h2", { text: "Git Author 정보 입력" });
        contentEl.createEl("p", {
            text:
                "Git commit 메타데이터에 들어갈 작성자 이름과 이메일을 입력해주세요. " +
                "한 번만 설정하면 vault의 .git/config에 저장되고, 이후엔 다시 묻지 않습니다.",
        });

        new Setting(contentEl).setName("이름 (user.name)").addText((text) => {
            text.setPlaceholder("예: 홍길동").onChange((v) => {
                this.inputName = v;
            });
            // Focus the first field so the user can start typing immediately.
            window.setTimeout(() => text.inputEl.focus(), 0);
        });

        new Setting(contentEl)
            .setName("이메일 (user.email)")
            .addText((text) => {
                text.setPlaceholder("예: hong@example.com").onChange((v) => {
                    this.inputEmail = v;
                });
            });

        new Setting(contentEl)
            .addButton((btn) =>
                btn
                    .setButtonText("확인")
                    .setCta()
                    .onClick(() => {
                        const name = this.inputName.trim();
                        const email = this.inputEmail.trim();
                        if (!name || !email) {
                            new Notice(
                                "이름과 이메일을 모두 입력하거나 '건너뛰기'를 누르세요."
                            );
                            return;
                        }
                        this.result = { kind: "input", name, email };
                        this.close();
                    })
            )
            .addButton((btn) =>
                btn.setButtonText("건너뛰기 (Anonymous 사용)").onClick(() => {
                    this.result = { kind: "skip" };
                    this.close();
                })
            );

        contentEl.createEl("p", {
            text:
                "건너뛰면 'Anonymous <anonymous@local>'로 commit이 기록됩니다. " +
                "협업하는 vault라면 plugin 설정 화면에서 나중에 변경할 수 있습니다.",
            cls: "obsidian-git-author-modal-hint",
        });
    }

    override onClose(): void {
        this.contentEl.empty();
        this.resolveFn?.(this.result);
    }

    async openAndGetResult(): Promise<AuthorInfoResult> {
        return new Promise<AuthorInfoResult>((resolve) => {
            this.resolveFn = resolve;
            this.open();
        });
    }
}
