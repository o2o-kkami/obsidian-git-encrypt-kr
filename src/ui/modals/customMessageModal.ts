import { moment, SuggestModal } from "obsidian";
import type ObsidianGit from "src/main";

export class CustomMessageModal extends SuggestModal<string> {
    resolve:
        | ((value: string | PromiseLike<string> | undefined) => void)
        | null = null;
    constructor(private readonly plugin: ObsidianGit) {
        super(plugin.app);
        this.setPlaceholder(
            "메시지를 입력하세요. 날짜가 추가된 버전을 선택할 수도 있습니다."
        );
    }

    openAndGetResult(): Promise<string> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.open();
        });
    }

    onClose() {
        // onClose gets called before onChooseItem
        void new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
            if (this.resolve) this.resolve(undefined);
        });
    }

    getSuggestions(query: string): string[] {
        const date = moment().format(this.plugin.settings.commitDateFormat);
        if (query == "") query = "...";
        return [query, `${date}: ${query}`, `${query}: ${date}`];
    }

    renderSuggestion(value: string, el: HTMLElement): void {
        el.innerText = value;
    }

    onChooseSuggestion(value: string, __: MouseEvent | KeyboardEvent) {
        if (this.resolve) this.resolve(value);
    }
}
