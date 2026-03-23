#!/bin/bash

# Advanced Weather Companion — Translation Builder
# Compiles .po files to .mo binaries and manages the locale directory structure.
#
# Layout (matches your existing tree):
#   locale/<lang>/LC_MESSAGES/advanced-weather.po  ← source files (already here)
#   locale/<lang>/LC_MESSAGES/advanced-weather.mo  ← produced by --compile

EXTENSION_NAME="advanced-weather"
LOCALE_DIR="locale"

# All shipped languages
SUPPORTED_LANGUAGES=(
    "de"    # German
    "es"    # Spanish
    "fr"    # French
    "it"    # Italian
    "ja"    # Japanese
    "ko"    # Korean
    "pt_BR" # Portuguese (Brazil)
    "ru"    # Russian
    "ta"    # Tamil
    "th"    # Thai
    "zh_CN" # Chinese Simplified
)

# Spanish locale aliases — compiled from es and copied so GJS resolves
# es_ES and es@latin without extra work in the extension.
ES_ALIASES=("es_ES" "es@latin")

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── helpers ──────────────────────────────────────────────────────────────────

die() { echo -e "${RED}Error: $*${NC}" >&2; exit 1; }

require_tools() {
    local missing=()
    for cmd in msgfmt msgmerge msginit; do
        command -v "$cmd" &>/dev/null || missing+=("$cmd")
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        echo -e "${RED}Error: missing gettext tools: ${missing[*]}${NC}"
        echo ""
        echo "Install with:"
        echo "  Debian/Ubuntu: sudo apt install gettext"
        echo "  Fedora:        sudo dnf install gettext"
        echo "  Arch:          sudo pacman -S gettext"
        echo "  macOS:         brew install gettext"
        exit 1
    fi
}

require_xgettext() {
    command -v xgettext &>/dev/null && return
    die "xgettext not found. Install gettext (see above)."
}

banner() {
    echo -e "${BOLD}${CYAN}Advanced Weather Companion — Translation Builder${NC}"
    echo    "=================================================="
}

po_file_for()  { echo "$LOCALE_DIR/$1/LC_MESSAGES/$EXTENSION_NAME.po"; }
mo_file_for()  { echo "$LOCALE_DIR/$1/LC_MESSAGES/$EXTENSION_NAME.mo"; }

# ── extract strings from JS sources ──────────────────────────────────────────

extract_strings() {
    echo -e "\n${YELLOW}Extracting translatable strings from JS sources...${NC}"
    require_xgettext

    local pot_file="$LOCALE_DIR/$EXTENSION_NAME.pot"

    local sources=()
    while IFS= read -r -d '' f; do
        sources+=("$f")
    done < <(find . \
        -not -path "./$LOCALE_DIR/*" \
        -not -path "./node_modules/*" \
        -name "*.js" -print0 2>/dev/null)

    if [ "${#sources[@]}" -eq 0 ]; then
        echo -e "${YELLOW}No .js source files found — skipping extraction.${NC}"
        return 0
    fi

    xgettext --from-code=UTF-8 \
             --language=JavaScript \
             --keyword=_ \
             --keyword=gettext \
             --package-name="$EXTENSION_NAME" \
             --package-version="2.0" \
             --msgid-bugs-address="https://github.com/Sanjai-Shaarugesh/Advanced-Weather-Companion/issues" \
             --output="$pot_file" \
             "${sources[@]}" 2>/dev/null || true

    if [ -f "$pot_file" ]; then
        local count
        count=$(grep -c '^msgid ' "$pot_file" 2>/dev/null || echo 0)
        echo -e "${GREEN}✓${NC} Template created: ${BOLD}$pot_file${NC} (${count} strings)"
    else
        echo -e "${YELLOW}No template created (no translatable strings found).${NC}"
    fi
}

# ── compile one language ──────────────────────────────────────────────────────

compile_translation() {
    local lang="$1"
    local po_file
    local mo_file
    po_file=$(po_file_for "$lang")
    mo_file=$(mo_file_for "$lang")

    if [ ! -f "$po_file" ]; then
        echo -e "${RED}✗${NC} $lang: .po file not found at ${BOLD}$po_file${NC}"
        return 1
    fi

    # Validate syntax before compiling
    local errors
    errors=$(msgfmt --check-format --check-header "$po_file" -o /dev/null 2>&1)
    if [ $? -ne 0 ]; then
        echo -e "${RED}✗${NC} $lang: Validation failed"
        echo "$errors" | sed 's/^/    /'
        return 1
    fi

    msgfmt "$po_file" -o "$mo_file"

    local stats
    stats=$(msgfmt --statistics "$po_file" -o /dev/null 2>&1)
    echo -e "${GREEN}✓${NC} $lang: Compiled successfully"
    echo "  └─ $stats"

    # Spanish aliases
    if [ "$lang" = "es" ]; then
        for alias in "${ES_ALIASES[@]}"; do
            local alias_dir="$LOCALE_DIR/$alias/LC_MESSAGES"
            mkdir -p "$alias_dir"
            cp "$mo_file" "$alias_dir/$EXTENSION_NAME.mo"
            cp "$po_file" "$alias_dir/$EXTENSION_NAME.po"
            echo -e "  ${BLUE}↳${NC} alias ${alias} created"
        done
    fi

    return 0
}

# ── compile all languages ─────────────────────────────────────────────────────

compile_all() {
    echo -e "\n${YELLOW}Compiling all translations...${NC}"

    local success=0 failed=0 skipped=0

    for lang in "${SUPPORTED_LANGUAGES[@]}"; do
        if [ -f "$(po_file_for "$lang")" ]; then
            if compile_translation "$lang"; then
                success=$((success + 1))
            else
                failed=$((failed + 1))
            fi
        else
            echo -e "${YELLOW}⊘${NC} $lang: not found, skipping"
            skipped=$((skipped + 1))
        fi
    done

    # Also pick up any extra languages present in the locale tree
    while IFS= read -r -d '' po_file; do
        local extra_lang
        extra_lang=$(basename "$(dirname "$(dirname "$po_file")")")

        local already=false
        for sl in "${SUPPORTED_LANGUAGES[@]}"; do
            [ "$extra_lang" = "$sl" ] && already=true && break
        done
        for alias in "${ES_ALIASES[@]}"; do
            [ "$extra_lang" = "$alias" ] && already=true && break
        done

        if [ "$already" = false ]; then
            echo -e "${CYAN}+${NC} $extra_lang: extra language found, compiling..."
            if compile_translation "$extra_lang"; then
                success=$((success + 1))
            else
                failed=$((failed + 1))
            fi
        fi
    done < <(find "$LOCALE_DIR" -name "$EXTENSION_NAME.po" -print0 2>/dev/null | sort -z)

    echo ""
    echo -e "${BOLD}Summary:${NC}"
    echo -e "  ${GREEN}Compiled:${NC}  $success"
    [ "$skipped" -gt 0 ] && echo -e "  ${YELLOW}Skipped:${NC}   $skipped"
    if [ "$failed" -gt 0 ]; then
        echo -e "  ${RED}Failed:    $failed${NC}"
        return 1
    fi
    return 0
}

# ── update existing .po from template ────────────────────────────────────────

update_translation() {
    local lang="$1"
    local po_file
    po_file=$(po_file_for "$lang")
    local pot_file="$LOCALE_DIR/$EXTENSION_NAME.pot"

    [ -f "$pot_file" ] || die "Template not found at $pot_file. Run --extract first."

    if [ ! -f "$po_file" ]; then
        echo -e "${YELLOW}Creating new translation file for ${lang}...${NC}"
        mkdir -p "$LOCALE_DIR/$lang/LC_MESSAGES"
        msginit --input="$pot_file" \
                --output-file="$po_file" \
                --locale="$lang" \
                --no-translator 2>/dev/null
        echo -e "${GREEN}✓${NC} $lang: Created from template"
    else
        echo -e "${YELLOW}Updating ${lang} from template...${NC}"
        msgmerge --update --quiet "$po_file" "$pot_file"
        echo -e "${GREEN}✓${NC} $lang: Updated"
    fi
}

# ── create a new locale scaffold ─────────────────────────────────────────────

create_translation() {
    local lang="$1"
    [ -n "$lang" ] || die "Language code required.\nUsage: $0 --create LANG_CODE"

    local po_file
    po_file=$(po_file_for "$lang")
    local pot_file="$LOCALE_DIR/$EXTENSION_NAME.pot"

    [ ! -f "$po_file" ] || die "Translation for '$lang' already exists at $po_file"

    if [ ! -f "$pot_file" ]; then
        echo -e "${YELLOW}Template not found — extracting strings first...${NC}"
        extract_strings
    fi

    [ -f "$pot_file" ] || die "No template available. Add translatable strings to your JS files first."

    echo -e "${YELLOW}Creating new translation for ${lang}...${NC}"
    mkdir -p "$LOCALE_DIR/$lang/LC_MESSAGES"
    msginit --input="$pot_file" \
            --output-file="$po_file" \
            --locale="$lang" \
            --no-translator 2>/dev/null

    echo -e "${GREEN}✓${NC} Created: ${BOLD}$po_file${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Edit $po_file and fill in the msgstr values"
    echo "  2. Run:  $0 --compile $lang"
    echo "  3. Restart GNOME Shell to test: Alt+F2 → r → Enter"
}

# ── validate .po syntax only ──────────────────────────────────────────────────

check_translations() {
    echo -e "\n${YELLOW}Checking .po file syntax...${NC}"

    local ok=0 fail=0

    for lang in "${SUPPORTED_LANGUAGES[@]}"; do
        local po_file
        po_file=$(po_file_for "$lang")
        if [ ! -f "$po_file" ]; then
            echo -e "  ${YELLOW}⊘${NC} $lang: not found"
            continue
        fi
        local errors
        errors=$(msgfmt --check-format --check-header "$po_file" -o /dev/null 2>&1)
        if [ $? -eq 0 ]; then
            echo -e "  ${GREEN}✓${NC} $lang: syntax OK"
            ok=$((ok + 1))
        else
            echo -e "  ${RED}✗${NC} $lang: errors found"
            echo "$errors" | sed 's/^/      /'
            fail=$((fail + 1))
        fi
    done

    echo ""
    [ "$fail" -gt 0 ] && echo -e "${RED}$fail file(s) have errors.${NC}" && return 1
    echo -e "${GREEN}All $ok file(s) passed.${NC}"
}

# ── list status of all translations ──────────────────────────────────────────

list_translations() {
    echo -e "\n${YELLOW}Available translations:${NC}"
    echo ""

    local found=0
    while IFS= read -r -d '' po_file; do
        local lang mo_file compiled stats
        lang=$(basename "$(dirname "$(dirname "$po_file")")")
        mo_file="${po_file%.po}.mo"
        found=1

        if [ -f "$mo_file" ]; then
            if [ "$mo_file" -nt "$po_file" ]; then
                compiled="${GREEN}[compiled]${NC}"
            else
                compiled="${YELLOW}[needs recompile]${NC}"
            fi
        else
            compiled="${RED}[not compiled]${NC}"
        fi

        stats=$(msgfmt --statistics "$po_file" -o /dev/null 2>&1)
        echo -e "  ${BLUE}${lang}${NC}  $compiled"
        echo    "    └─ $stats"
    done < <(find "$LOCALE_DIR" -name "$EXTENSION_NAME.po" -print0 2>/dev/null | sort -z)

    [ "$found" -eq 0 ] && echo "  (no .po files found under ${LOCALE_DIR}/)"
}

# ── show translation coverage percentages ────────────────────────────────────

show_stats() {
    echo -e "\n${YELLOW}Translation Statistics:${NC}"
    echo ""
    printf "  ${BOLD}%-12s  %-8s  %-10s  %-10s  %s${NC}\n" \
           "Language" "Transl." "Fuzzy" "Untransl." "Coverage"
    printf "  %-12s  %-8s  %-10s  %-10s  %s\n" \
           "────────────" "────────" "──────────" "──────────" "────────"

    for lang in "${SUPPORTED_LANGUAGES[@]}"; do
        local po_file
        po_file=$(po_file_for "$lang")
        if [ ! -f "$po_file" ]; then
            printf "  %-12s  %s\n" "$lang" "(not found)"
            continue
        fi

        local raw translated fuzzy untranslated total coverage
        raw=$(msgfmt --statistics "$po_file" -o /dev/null 2>&1)
        translated=$(echo "$raw"   | grep -oP '\d+(?= translated)'   || echo 0)
        fuzzy=$(echo "$raw"        | grep -oP '\d+(?= fuzzy)'        || echo 0)
        untranslated=$(echo "$raw" | grep -oP '\d+(?= untranslated)' || echo 0)
        translated=${translated:-0}
        fuzzy=${fuzzy:-0}
        untranslated=${untranslated:-0}
        total=$(( translated + fuzzy + untranslated ))

        if [ "$total" -gt 0 ]; then
            coverage=$(( translated * 100 / total ))
        else
            coverage=0
        fi

        local cov_col
        if   [ "$coverage" -ge 95 ]; then cov_col="${GREEN}"
        elif [ "$coverage" -ge 70 ]; then cov_col="${YELLOW}"
        else                               cov_col="${RED}"
        fi

        printf "  %-12s  %-8s  %-10s  %-10s  ${cov_col}%d%%${NC}\n" \
               "$lang" "$translated" "$fuzzy" "$untranslated" "$coverage"
    done
    echo ""
}

# ── remove msgmerge backups ───────────────────────────────────────────────────

clean_backups() {
    echo -e "\n${YELLOW}Cleaning backup files...${NC}"
    local count
    count=$(find "$LOCALE_DIR" -name "*.po~" 2>/dev/null | wc -l)
    if [ "$count" -gt 0 ]; then
        find "$LOCALE_DIR" -name "*.po~" -delete
        echo -e "${GREEN}✓${NC} Removed $count backup file(s)"
    else
        echo -e "${GREEN}✓${NC} No backup files found"
    fi
}

# ── remove all compiled .mo files ────────────────────────────────────────────

clean_compiled() {
    echo -e "\n${YELLOW}Removing all compiled .mo files...${NC}"
    local count
    count=$(find "$LOCALE_DIR" -name "*.mo" 2>/dev/null | wc -l)
    if [ "$count" -gt 0 ]; then
        find "$LOCALE_DIR" -name "*.mo" -delete
        echo -e "${GREEN}✓${NC} Removed $count compiled file(s)"
    else
        echo -e "${GREEN}✓${NC} Nothing to clean"
    fi
}

# ── help ──────────────────────────────────────────────────────────────────────

show_help() {
    echo -e "${BOLD}Advanced Weather Companion — Translation Builder${NC}"
    echo ""
    echo -e "${BOLD}Usage:${NC} $0 [OPTION] [LANG]"
    echo ""
    echo -e "${BOLD}Options:${NC}"
    echo -e "  ${CYAN}--extract${NC}              Extract translatable strings from *.js → POT template"
    echo -e "  ${CYAN}--compile${NC} [LANG]       Compile .po → .mo  (all languages if LANG omitted)"
    echo -e "  ${CYAN}--update${NC}  LANG         Merge new strings from template into an existing .po"
    echo -e "  ${CYAN}--create${NC}  LANG         Scaffold a new .po file from the template"
    echo -e "  ${CYAN}--check${NC}                Validate .po syntax without compiling"
    echo -e "  ${CYAN}--list${NC}                 Show all translations and compile status"
    echo -e "  ${CYAN}--stats${NC}                Show translation coverage percentages"
    echo -e "  ${CYAN}--clean${NC}                Remove msgmerge backup files (*.po~)"
    echo -e "  ${CYAN}--clean-compiled${NC}       Remove all compiled .mo files"
    echo -e "  ${CYAN}--all${NC}                  Full rebuild: extract → update all → compile all → clean"
    echo -e "  ${CYAN}--help${NC}                 Show this message"
    echo ""
    echo -e "${BOLD}Supported languages:${NC}"
    echo    "  de        German"
    echo    "  es        Spanish  (aliases es_ES and es@latin are auto-created on compile)"
    echo    "  fr        French"
    echo    "  it        Italian"
    echo    "  ja        Japanese"
    echo    "  ko        Korean"
    echo    "  pt_BR     Portuguese (Brazil)"
    echo    "  ru        Russian"
    echo    "  ta        Tamil"
    echo    "  th        Thai"
    echo    "  zh_CN     Chinese (Simplified)"
    echo ""
    echo -e "${BOLD}Examples:${NC}"
    echo    "  $0 --compile              # Compile every language"
    echo    "  $0 --compile de           # Compile only German"
    echo    "  $0 --update fr            # Pull new strings into French .po"
    echo    "  $0 --create hi            # Scaffold a new Hindi translation"
    echo    "  $0 --check                # Validate all .po files"
    echo    "  $0 --list                 # Show status of all translations"
    echo    "  $0 --stats                # Show coverage % per language"
    echo    "  $0 --all                  # Full rebuild cycle"
    echo ""
    echo -e "${BOLD}Additional languages you can scaffold with --create:${NC}"
    echo    "  ar  hi  nl  pl  tr  sv  nb  fi  cs  hu  uk  vi  id  ms  bn"
    echo ""
    echo -e "${BOLD}Directory layout (your existing structure):${NC}"
    echo    "  locale/"
    echo    "  ├── de/"
    echo    "  │   └── LC_MESSAGES/"
    echo    "  │       ├── $EXTENSION_NAME.po   ← source (edit this)"
    echo    "  │       └── $EXTENSION_NAME.mo   ← compiled (generated)"
    echo    "  ├── ru/"
    echo    "  │   └── LC_MESSAGES/"
    echo    "  │       ├── $EXTENSION_NAME.po"
    echo    "  │       └── $EXTENSION_NAME.mo"
    echo    "  └── ..."
    echo ""
}

# ── dispatch ──────────────────────────────────────────────────────────────────

banner
require_tools

case "${1:-}" in
    --extract)
        extract_strings
        ;;
    --compile)
        if [ -n "${2:-}" ]; then
            compile_translation "$2"
        else
            compile_all
        fi
        ;;
    --update)
        [ -n "${2:-}" ] || die "Language code required.\nUsage: $0 --update LANG"
        update_translation "$2"
        ;;
    --create)
        create_translation "${2:-}"
        ;;
    --check)
        check_translations
        ;;
    --list)
        list_translations
        ;;
    --stats)
        show_stats
        ;;
    --clean)
        clean_backups
        ;;
    --clean-compiled)
        clean_compiled
        ;;
    --all)
        extract_strings
        echo -e "\n${YELLOW}Updating all translations from template...${NC}"
        for lang in "${SUPPORTED_LANGUAGES[@]}"; do
            [ -f "$(po_file_for "$lang")" ] && update_translation "$lang"
        done
        compile_all
        clean_backups
        ;;
    --help|"")
        show_help
        ;;
    *)
        echo -e "${RED}Unknown option: $1${NC}"
        show_help
        exit 1
        ;;
esac

exit 0