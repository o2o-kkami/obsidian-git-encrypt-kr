# Obsidian Git Plugin — Encryption Fork (`obsidian-git-encrypt-kr`)

> ## 🔐 Fork notice
>
> This repository is a **fork** of [Vinzent03/obsidian-git](https://github.com/Vinzent03/obsidian-git),
> based on upstream **v2.38.2**, that adds a transparent **AES-256-GCM encryption layer** on top.
>
> - Files in your vault are encrypted with a password-derived key (PBKDF2) **before** they are
>   pushed to the git remote. Only **ciphertext** is uploaded — anyone without the password
>   (including the git hosting provider) cannot read the file contents on the remote.
> - All original plugin features and usage described in the README below remain unchanged.
>   Fork-specific configuration (encryption password setup, etc.) is exposed as a separate
>   section in the plugin's Settings tab.
> - Plugin version `2.38.2-enc.N` tracks upstream **v2.38.2** + encryption-fork patch level `N`.
>
> **Where to file issues**
> - Fork-specific (encryption layer, Korean-language UI, this repo): [Issues in this repo](https://github.com/o2o-kkami/obsidian-git-encrypt-kr/issues)
> - Core plugin behavior (commit/push/pull, Source Control View, etc.): [Upstream repo](https://github.com/Vinzent03/obsidian-git/issues)
>
> **License**: MIT (same as upstream — `LICENSE` retained unchanged).
> **Original authors**: [@Vinzent03](https://github.com/Vinzent03), [@denolehov](https://github.com/denolehov),
> plus all upstream contributors (see the **Contributors** tab and `git log`). Their README body,
> Credits, and Ko-fi support link below are preserved as-is — please direct support to the
> original authors, not to this fork.
>
> ### 🇰🇷 한국어 안내
>
> 이 저장소는 [Vinzent03/obsidian-git](https://github.com/Vinzent03/obsidian-git)의 **포크(fork)** 이며,
> 기반 버전은 upstream **v2.38.2** 입니다. 원본 plugin 위에 **AES-256-GCM 투명 암호화 레이어**를
> 추가한 버전입니다.
>
> - 비밀번호로 도출한 키(PBKDF2)로 vault 파일을 암호화한 뒤 git 원격으로 push 합니다.
>   원격 저장소(GitHub/GitLab 등)에는 **ciphertext만** 올라가며, 비밀번호를 모르는 사람
>   (호스팅 제공자 포함)은 파일 내용을 읽을 수 없습니다.
> - 원본 plugin의 모든 기능과 사용법은 아래 README 본문 그대로 적용됩니다. 본 fork 고유 설정
>   (암호화 비밀번호 등)은 plugin 설정 화면에 별도 섹션으로 추가되어 있습니다.
> - plugin 버전 `2.38.2-enc.N`은 upstream **v2.38.2** + 암호화 fork 패치 레벨 `N`을 의미합니다.
>
> **이슈 제출 안내**
> - 본 fork(암호화 레이어, 한국어 UI 등) 관련: **본 저장소** ([Issues](https://github.com/o2o-kkami/obsidian-git-encrypt-kr/issues))
> - plugin 본체 기능(commit/push/pull, Source Control View 등): [원본 저장소](https://github.com/Vinzent03/obsidian-git/issues)
>
> **라이선스**: MIT (원본과 동일, 본 fork에도 `LICENSE` 파일 그대로 유지).
> **원작자**: [@Vinzent03](https://github.com/Vinzent03), [@denolehov](https://github.com/denolehov) 외
> 모든 upstream 기여자 (**Contributors** 탭 및 `git log` 참조).
> 아래 README 본문, Credits, Ko-fi 후원 링크는 모두 원저자 그대로이며,
> 후원은 fork가 아닌 원저자에게 보내주세요.

---

A powerful community plugin for [Obsidian.md](Obsidian.md) that brings Git integration right into your vault. Automatically commit, pull, push, and see your changes — all within Obsidian.

## 📚 Documentation

All setup instructions (including mobile), common issues, tips, and advanced configuration can be found in the 📖 [full documentation](https://publish.obsidian.md/git-doc).

> Mobile users: The plugin is **highly unstable ⚠️ !** Please check the dedicated [Mobile](#-mobile-support-%EF%B8%8F--experimental) section below.

## Key Features

- 🔁 **Automatic commit-and-sync** (commit, pull, and push) on a schedule.
- 📥 **Auto-pull on Obsidian startup**
- 📂 **Submodule support** for managing multiple repositories (desktop only and opt-in)
- 🔧 **Source Control View** to stage/unstage, commit and diff files - Open it with the `Open source control view` command.
- 📜 **History View** for browsing commit logs and changed files - Open it with the `Open history view` command.
- 🔍 **Diff View** for viewing changes in a file - Open it with the `Open diff view` command.
- 📝 **Signs in the editor** to indicate added, modified, and deleted lines/hunks (desktop only).
- GitHub integration to open files and history in your browser

> For detailed file history, consider pairing this plugin with the [Version History Diff](obsidian://show-plugin?id=obsidian-version-history-diff) plugin.

## UI Previews

### 🔧 Source Control View

Manage your file changes directly inside Obsidian like stage/unstage individual files and commit them.

![Source Control View](https://raw.githubusercontent.com/Vinzent03/obsidian-git/master/images/source-view.png)

### 📜 History View

Show the commit history of your repository. The commit message, author, date, and changed files can be shown. Author and date are disabled by default as shown in the screenshot, but can be enabled in the settings.

![History View](https://raw.githubusercontent.com/Vinzent03/obsidian-git/master/images/history-view.png)

### 🔍 Diff View 

Compare versions with a clear and concise diff viewer.
Open it from the source control view or via the `Open diff view` command.

![Diff View](https://raw.githubusercontent.com/Vinzent03/obsidian-git/master/images/diff-view.png)

### 📝 Signs in the Editor

View line-by-line changes directly in the editor with added, modified, and deleted line/hunk indicators. You can stage and reset changes right from the signs. There also commands to navigate between hunks and stage/reset hunks under the cursor. Needs to be enabled in the plugin settings.

![Signs](https://raw.githubusercontent.com/Vinzent03/obsidian-git/master/images/signs.png)

## Available Commands
> Not exhaustive - these are just some of the most common commands. For a full list, see the Command Palette in Obsidian.

- 🔄 Changes
  - `List changed files`: Lists all changes in a modal
  - `Open diff view`: Open diff view for the current file
  - `Stage current file`
  - `Unstage current file`
  - `Discard all changes`: Discard all changes in the repository
- ✅ Commit
  - `Commit`: If files are staged only commits those, otherwise commits only files that have been staged
  - `Commit with specific message`: Same as above, but with a custom message
  - `Commit all changes`: Commits all changes without pushing
  - `Commit all changes with specific message`: Same as above, but with a custom message
- 🔀 Commit-and-sync
  - `Commit-and-sync`: With default settings, this will commit all changes, pull, and push
  - `Commit-and-sync with specific message`: Same as above, but with a custom message
  - `Commit-and-sync and close`: Same as `Commit-and-sync`, but if running on desktop, will close the Obsidian window. Will not exit Obsidian app on mobile.
- 🌐 Remote
  - `Push`, `Pull`
  - `Edit remotes`: Add new remotes or edit existing remotes
  - `Remove remote`
  - `Clone an existing remote repo`: Opens dialog that will prompt for URL and authentication to clone a remote repo
  - `Open file on GitHub`: Open the file view of the current file on GitHub in a browser window. Note: only works on desktop
  - `Open file history on GitHub`: Open the file history of the current file on GitHub in a browser window. Note: only works on desktop
- 🏠 Manage local repository
  - `Initialize a new repo`
  - `Create new branch`
  - `Delete branch`
  - `CAUTION: Delete repository`
- 🧪 Miscellaneous
  - `Open source control view`: Opens side pane displaying [Source control view](#sidebar-view)
  - `Open history view`: Opens side pane displaying [History view](#history-view)
  - `Edit .gitignore`
  - `Add file to .gitignore`: Add current file to `.gitignore`

## 💻 Desktop Notes

### 🔐 Authentication

Some Git services may require further setup for HTTPS/SSH authentication. Refer to the [Authentication Guide](https://publish.obsidian.md/git-doc/Authentication)

### Obsidian on Linux

- ⚠️  Snap is not supported due to its sandboxing restrictions.
- ⚠️  Flatpak is not recommended, because it doesn't have access to all system files. They are actively fixing many issues, but there are still issues. Especially with more advanced setups.
- ✅ Please use AppImage or a full access installation of your system's package manager instead ([Linux installation guide](https://publish.obsidian.md/git-doc/Installation#Linux))

## 📱 Mobile Support (⚠️  Experimental)

The Git implementation on mobile is **very unstable**! I would not recommend using this plugin on mobile, but try other syncing services.

One such alternative is [GitSync](https://github.com/ViscousPot/GitSync), which is available on both Android and iOS. It is not associated with this plugin, but it may be a better option for mobile users. A tutorial for setting it up can be found [here](https://viscouspotenti.al/posts/gitsync-all-devices-tutorial).

> 🧪 The Git plugin works on mobile thanks to [isomorphic-git](https://isomorphic-git.org/), a JavaScript-based re-implementation of Git - but it comes with serious limitations and issues. It is not possible for an Obsidian plugin to use a native Git installation on Android or iOS.

### ❌ Mobile Feature Limitations

- No **SSH authentication** ([isomorphic-git issue](https://github.com/isomorphic-git/isomorphic-git/issues/231))
- Limited repo size, because of memory restrictions
- No rebase merge strategy
- No submodules support

### ⚠️ Performance Caveats

> [!caution]
> Depending on your device and available free RAM, Obsidian may
>
> - crash on clone/pull
> - create buffer overflow errors
> - run indefinitely.
>
> It's caused by the underlying git implementation on mobile, which is not efficient. I don't know how to fix this. If that's the case for you, I have to admit this plugin won't work for you. So commenting on any issue or creating a new one won't help. I am sorry.

### Tips for Mobile Use:

If you have a large repo/vault I recommend to stage individual files and only commit staged files.

## 🙋 Contact & Credits

- The Line Authoring feature was developed by [GollyTicker](https://github.com/GollyTicker), so any questions may be best answered by her.
- This plugin was initial developed by [denolehov](https://github.com/denolehov). Since March 2021, it's me [Vinzent03](https://github.com/Vinzent03) who is developing this plugin. That's why the GitHub repository got moved to my account in July 2024.
- If you have any kind of feedback or questions, feel free to reach out via GitHub issues.

## ☕ Support

If you find this plugin useful and would like to support its development, you can support me on Ko-fi.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/F1F195IQ5)
