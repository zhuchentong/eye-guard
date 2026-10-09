#!/usr/bin/env bash
# eye-guard 一键安装脚本：按发行版自动选择 deb / rpm / AppImage。
#
# 用法（一行安装）:
#   curl -fsSL https://raw.githubusercontent.com/zhuchentong/eye-guard/master/scripts/install.sh | bash
#
# 参数:
#   --appimage   强制 AppImage 用户级安装（免 root）
#   --uninstall  卸载（自动清理 deb/rpm/用户级 AppImage 三种安装）
#   -h, --help   帮助
#
# 环境变量:
#   GH_MIRROR    GitHub 加速镜像前缀（ghproxy 风格，<mirror>/https://github.com/...），
#                同时作用于脚本内所有下载 URL

set -euo pipefail

REPO="zhuchentong/eye-guard"
BIN_NAME="eye-guard"
TAG=""

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

err()  { printf '[install] %s\n' "$*" >&2; }
info() { printf '[install] %s\n' "$*"; }
die()  { err "$*"; exit 1; }

usage() {
	cat <<'EOF'
eye-guard 一键安装脚本

用法:
  install.sh [--appimage] [--uninstall] [-h]

选项:
  --appimage   强制 AppImage 用户级安装（免 root，自动创建菜单项）
  --uninstall  卸载：清理 deb/rpm 包与用户级 AppImage 安装
  -h, --help   显示本帮助

环境变量:
  GH_MIRROR    GitHub 加速镜像前缀（ghproxy 风格：<mirror>/https://github.com/...）

安装策略:
  有 apt            -> 下载 deb 并安装（自动补齐 webkit2gtk 等运行时依赖，需 root）
  有 dnf / zypper   -> 下载 rpm 并安装（需 root）
  其他              -> AppImage 用户级安装到 ~/.local（无需 root；
                       无 FUSE 时自动 --appimage-extract 落地，规避 libfuse2 缺失）
EOF
}

have() { command -v "$1" >/dev/null 2>&1; }

is_root() { [ "$(id -u)" = 0 ]; }

# 输出 github.com 路径对应的最终 URL（应用镜像前缀）
gh_url() {
	if [ -n "${GH_MIRROR:-}" ]; then
		printf '%s/https://github.com/%s\n' "${GH_MIRROR%/}" "$1"
	else
		printf 'https://github.com/%s\n' "$1"
	fi
}

# 解析 SUDO 数组：root 时为空数组，否则要求 sudo；无 sudo 返回 1
resolve_sudo() {
	if is_root; then
		SUDO=()
	elif have sudo; then
		SUDO=(sudo)
	else
		return 1
	fi
}

# 获取最新 release tag。
# 主通道：releases/latest 的 302 Location（不经 api.github.com，国内可达性更好且无限流）；
# 回退：GitHub API 的 tag_name。
latest_tag() {
	local tag=""
	tag="$(curl -fsSI "$(gh_url "$REPO/releases/latest")" 2>/dev/null |
		tr -d '\r' | grep -i '^location:' | tail -n1 |
		sed -E 's#^.*/tag/([^/?]+).*#\1#')" || tag=""
	case "$tag" in v*) printf '%s\n' "$tag"; return 0 ;; esac
	tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
		sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)" || tag=""
	case "$tag" in v*) printf '%s\n' "$tag"; return 0 ;; esac
	return 1
}

# 定位资产下载 URL：命名约定拼装 + HEAD 校验；失配时回退 API JSON 按扩展名筛选。
asset_url() { # $1: deb | rpm | appimage
	local ver="${TAG#v}" name ext guess url list
	case "$1" in
		deb) name="eye-guard_${ver}_amd64.deb" ext='\.deb$' ;;
		rpm) name="eye-guard-${ver}-1.x86_64.rpm" ext='\.rpm$' ;;
		appimage) name="eye-guard_${ver}_amd64.AppImage" ext='\.AppImage$' ;;
		*) return 1 ;;
	esac
	guess="$(gh_url "$REPO/releases/download/$TAG/$name")"
	if curl -fsIL "$guess" >/dev/null 2>&1; then
		printf '%s\n' "$guess"
		return 0
	fi
	list="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/$TAG" 2>/dev/null)" || list=""
	url="$(printf '%s\n' "$list" |
		sed -n 's/.*"browser_download_url":[[:space:]]*"\([^"]*\)".*/\1/p' |
		grep -E "$ext" | head -n1)" || url=""
	[ -n "$url" ] || return 1
	if [ -n "${GH_MIRROR:-}" ]; then
		url="$(printf '%s/https://github.com/%s\n' "${GH_MIRROR%/}" "${url#https://github.com/}")"
	fi
	printf '%s\n' "$url"
}

download() { # $1: URL -> 下载到临时目录，输出本地文件路径
	local dest="$TMP/$(basename "$1")"
	curl -fL --progress-bar -o "$dest" "$1"
	printf '%s\n' "$dest"
}

fuse_available() {
	[ -e /dev/fuse ] && { have fusermount || have fusermount3; }
}

install_package() { # $1: deb | rpm
	local url f
	url="$(asset_url "$1")" ||
		die "未在 tag $TAG 找到 $1 资产，请手动下载：https://github.com/$REPO/releases"
	f="$(download "$url")"
	info "安装 $f"
	if [ "$1" = deb ]; then
		"${SUDO[@]}" apt-get install -y "$f"
	elif have dnf; then
		"${SUDO[@]}" dnf install -y "$f"
	else
		"${SUDO[@]}" zypper --non-interactive install "$f"
	fi
	info "安装完成：从应用菜单启动 $BIN_NAME"
}

# AppImage 用户级安装 + 桌面集成（菜单项/图标/--break 动作）。
install_appimage() {
	local url f sq bin_dir app_dir wrapper desktop
	bin_dir="$HOME/.local/bin"
	app_dir="$HOME/.local/lib/$BIN_NAME"
	url="$(asset_url appimage)" ||
		die "未在 tag $TAG 找到 AppImage 资产，请手动下载：https://github.com/$REPO/releases"
	f="$(download "$url")"
	chmod +x "$f"
	# 无论安装路径是否需要 FUSE，都解包一份用于桌面文件与图标
	(cd "$TMP" && "$f" --appimage-extract >/dev/null 2>&1)
	sq="$TMP/squashfs-root"
	[ -d "$sq" ] || die "AppImage 解包失败"

	mkdir -p "$bin_dir" "$app_dir"
	if fuse_available; then
		install -m 0755 "$f" "$bin_dir/$BIN_NAME.AppImage"
		wrapper="$bin_dir/$BIN_NAME.AppImage"
		info "FUSE 可用：AppImage 安装到 $bin_dir"
	else
		rm -rf "$app_dir"
		cp -a "$sq/." "$app_dir/"
		wrapper="$app_dir/AppRun"
		info "无 FUSE：解包目录安装到 $app_dir"
	fi
	# 统一 wrapper：保证命令行（--break）与桌面菜单指向一致
	{ printf '#!/usr/bin/env sh\n'; printf 'exec %q "$@"\n' "$wrapper"; } > "$bin_dir/$BIN_NAME"
	chmod 0755 "$bin_dir/$BIN_NAME"

	desktop="$(find "$sq/usr/share/applications" -maxdepth 1 -name '*.desktop' 2>/dev/null | head -n1)" || desktop=""
	if [ -n "$desktop" ]; then
		mkdir -p "$HOME/.local/share/applications"
		# Exec 改写为 wrapper 绝对路径；~/.local/bin 不在 PATH 时菜单项也能启动
		sed -E "s|^Exec=.*|Exec=$bin_dir/$BIN_NAME|" "$desktop" \
			> "$HOME/.local/share/applications/$BIN_NAME.desktop"
		# 声明动作入口（只插进第一个 section 的 Type= 行之后）
		sed -i -E '0,/^(Type=.*)$/s//\1\nActions=break;/' \
			"$HOME/.local/share/applications/$BIN_NAME.desktop"
		printf '\n[Desktop Action break]\nExec=%s --break\nName=立即休息\n' "$bin_dir/$BIN_NAME" \
			>> "$HOME/.local/share/applications/$BIN_NAME.desktop"
		if [ -d "$sq/usr/share/icons" ]; then
			mkdir -p "$HOME/.local/share/icons"
			cp -a "$sq/usr/share/icons/." "$HOME/.local/share/icons/" 2>/dev/null || true
		fi
		if have update-desktop-database; then
			update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
		fi
		info "桌面集成完成：菜单启动 + 右键「立即休息」"
	fi
	case ":$PATH:" in
		*":$bin_dir:"*) ;;
		*) err "提示：$bin_dir 不在 PATH 中，命令行功能（eye-guard --break）需先将其加入 PATH" ;;
	esac
	info "安装完成：$bin_dir/$BIN_NAME"
}

uninstall_all() {
	resolve_sudo || true
	if have dpkg && dpkg -s "$BIN_NAME" >/dev/null 2>&1; then
		info "移除 deb 包"
		"${SUDO[@]}" apt-get remove -y "$BIN_NAME"
	fi
	if have rpm && rpm -q "$BIN_NAME" >/dev/null 2>&1; then
		info "移除 rpm 包"
		if have dnf; then
			"${SUDO[@]}" dnf remove -y "$BIN_NAME"
		else
			"${SUDO[@]}" zypper --non-interactive remove "$BIN_NAME"
		fi
	fi
	rm -f "$HOME/.local/bin/$BIN_NAME" "$HOME/.local/bin/$BIN_NAME.AppImage"
	rm -rf "$HOME/.local/lib/$BIN_NAME"
	rm -f "$HOME/.local/share/applications/$BIN_NAME.desktop"
	find "$HOME/.local/share/icons" -name "$BIN_NAME.*" -delete 2>/dev/null || true
	info "卸载完成"
}

main() {
	local force_appimage=0
	while [ $# -gt 0 ]; do
		case "$1" in
			--appimage) force_appimage=1 ;;
			--uninstall) uninstall_all; exit 0 ;;
			-h | --help) usage; exit 0 ;;
			*) die "未知参数：$1（见 --help）" ;;
		esac
		shift
	done
	[ "$(uname -s)" = "Linux" ] || die "仅支持 Linux"
	[ "$(uname -m)" = "x86_64" ] || die "仅支持 x86_64（发布流水线未产出其他架构产物）"
	have curl || die "缺少 curl，请先安装"

	info "获取最新版本号..."
	TAG="$(latest_tag)" ||
		die "无法获取最新版本。网络受限时请设置镜像前缀：GH_MIRROR=<mirror> 重试"
	info "最新版本 $TAG"

	if [ "$force_appimage" = 0 ] && have apt && resolve_sudo; then
		install_package deb
		exit 0
	fi
	if [ "$force_appimage" = 0 ] && { have dnf || have zypper; } && resolve_sudo; then
		install_package rpm
		exit 0
	fi
	if [ "$force_appimage" = 0 ]; then
		info "未检测到 apt/dnf/zypper 或缺少 root 权限，改用 AppImage 用户级安装"
	fi
	install_appimage
}

# 仅直接执行时运行；source 时不跑，便于测试引用内部函数
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
	main "$@"
fi
