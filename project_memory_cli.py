#!/usr/bin/env python3
"""
Project Memory CLI
------------------
High-performance CLI interface for Obsidian project-memory plugin.
Calculates project scores, lists urgent tasks, logs session feedback,
extracts roadmap checkboxes, completes tasks, and manages Pomodoro sessions.
Uses data.json and a persistent incremental mtime cache for sub-millisecond to
low-millisecond execution even on large Obsidian vaults.
"""

import os
import sys
import json
import math
import re
import time
import argparse
from datetime import datetime, timezone

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def find_vault_dir(start_dir):
    curr = start_dir
    while curr and os.path.dirname(curr) != curr:
        if os.path.exists(os.path.join(curr, ".obsidian")):
            return curr
        curr = os.path.dirname(curr)
    return os.path.abspath(os.path.join(start_dir, "..", ".."))


VAULT_DIR = find_vault_dir(SCRIPT_DIR)
DATA_JSON_PATH = os.path.join(VAULT_DIR, ".obsidian", "plugins", "project-memory", "data.json")
CACHE_PATH = os.path.join(VAULT_DIR, ".obsidian", "plugins", "project-memory", ".project_cache.json")

EXCLUDED_DIRS = {
    ".obsidian", ".git", ".trash", ".claude", ".cursor",
    ".smart-env", ".pytest_cache", "attachments", "thumbnails",
    "excalidraw", "antigravity", "voicenotes", "readwise",
    "test_output_vault", "rattrapage_aib_pack", "templates",
    "tests", "agents", ".agents"
}

SYSTEM_FILES = {"agents.md", "readme.md", "claude.md", "gemini.md"}

DEFAULT_SETTINGS = {
    "projectTags": "todo, project",
    "archiveTag": "done",
    "rotationBonus": 0.1,
    "rapprochmentFactor": 0.2,
    "recencyPenaltyWeight": 0.5,
    "pomodoroDuration": 25,
    "deadlineProperty": "deadline"
}


def load_data(data_path=DATA_JSON_PATH):
    if not os.path.exists(data_path):
        return {
            "settings": DEFAULT_SETTINGS.copy(),
            "stats": {"projects": {}, "globalStats": {"totalReviews": 0, "totalPomodoroTime": 0}}
        }
    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if "settings" not in data:
        data["settings"] = DEFAULT_SETTINGS.copy()
    else:
        for k, v in DEFAULT_SETTINGS.items():
            if k not in data["settings"]:
                data["settings"][k] = v

    if "stats" not in data:
        data["stats"] = {"projects": {}, "globalStats": {"totalReviews": 0, "totalPomodoroTime": 0}}
    if "projects" not in data["stats"]:
        data["stats"]["projects"] = {}
    if "globalStats" not in data["stats"]:
        data["stats"]["globalStats"] = {"totalReviews": 0, "totalPomodoroTime": 0}
    return data


def save_data(data, data_path=DATA_JSON_PATH):
    os.makedirs(os.path.dirname(data_path), exist_ok=True)
    temp_path = data_path + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(temp_path, data_path)


def load_cache(cache_path=CACHE_PATH):
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_cache(cache, cache_path=CACHE_PATH):
    try:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        tmp = cache_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
        os.replace(tmp, cache_path)
    except Exception:
        pass


def parse_markdown_file(file_path, content=None, parse_checkboxes=True):
    """
    Parses a markdown file in a single fast pass for frontmatter, tags, checkboxes, wikilinks, and content.
    Returns: (frontmatter_dict, tags_set, checkboxes_list, content_str, wikilinks_list)
    """
    try:
        if content is None:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
    except Exception:
        return {}, set(), [], "", []

    frontmatter = {}
    tags = set()
    checkboxes = []
    wikilinks = []

    lines = content.splitlines()
    body_lines = lines

    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            fm_raw = parts[1]
            body_lines = parts[2].splitlines()
            in_tags = False
            for line in fm_raw.splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                if ":" in stripped and not stripped.startswith("-"):
                    k, v = stripped.split(":", 1)
                    k_str = k.strip().lower()
                    v_str = v.strip().strip("\"'")
                    frontmatter[k_str] = v_str
                    if k_str in ("tags", "tag"):
                        in_tags = True
                        if v_str.startswith("[") and v_str.endswith("]"):
                            items = v_str[1:-1].split(",")
                            for item in items:
                                t = item.strip().strip("\"'").lstrip("#")
                                if t:
                                    tags.add(t.lower())
                            in_tags = False
                        elif v_str:
                            items = v_str.split(",")
                            for item in items:
                                t = item.strip().strip("\"'").lstrip("#")
                                if t:
                                    tags.add(t.lower())
                            in_tags = False
                elif in_tags and stripped.startswith("-"):
                    t = stripped[1:].strip().strip("\"'").lstrip("#")
                    if t:
                        tags.add(t.lower())
                elif not stripped.startswith("-"):
                    in_tags = False

    # Inline tags `#tag`
    if "#" in content:
        inline_tags = re.findall(r'(?:^|[^\w#])#([a-zA-Z0-9_\-\/]+)', content)
        for tag in inline_tags:
            tags.add(tag.lower())

    # Wikilinks `[[Link]]`
    if "[[" in content:
        raw_links = re.findall(r'\[\[([^\]\|]+)(?:\|[^\]]+)?\]\]', content)
        for link in raw_links:
            clean_link = link.strip().lower()
            if clean_link.endswith(".md"):
                clean_link = clean_link[:-3]
            wikilinks.append(clean_link)

    # Checkboxes `[ ]` and `[x]`
    if parse_checkboxes and "[" in content and "]" in content:
        for idx, line in enumerate(body_lines, 1):
            if "[" in line and "]" in line:
                m = re.match(r'^\s*[-*+]\s+\[([ xX])\]\s+(.*)$', line)
                if m:
                    is_completed = m.group(1).lower() == 'x'
                    text = m.group(2).strip()
                    checkboxes.append({
                        "line": idx,
                        "completed": is_completed,
                        "text": text,
                        "raw": line
                    })

    return frontmatter, tags, checkboxes, content, wikilinks


def sync_vault_cache(vault_dir=VAULT_DIR, cache_path=CACHE_PATH, fast_mode=False):
    """
    Synchronizes the fast metadata cache with disk state using incremental mtime checks.
    Only modified files are re-read and parsed.
    """
    cache = load_cache(cache_path)
    if fast_mode and cache:
        return cache

    cache_dirty = False
    valid_paths = set()

    for root, dirs, files in os.walk(vault_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d.lower() not in EXCLUDED_DIRS]
        for f in files:
            if f.endswith(".md") and f.lower() not in SYSTEM_FILES:
                abs_p = os.path.join(root, f)
                rel_p = os.path.relpath(abs_p, vault_dir).replace("\\", "/")
                valid_paths.add(rel_p)
                try:
                    mt = os.path.getmtime(abs_p)
                except OSError:
                    continue

                cached = cache.get(rel_p)
                if not cached or cached.get("mtime") != mt:
                    fm, tags, _, _, wikilinks = parse_markdown_file(abs_p, parse_checkboxes=False)
                    deadline = str(fm.get("deadline") or fm.get("due") or "")
                    cache[rel_p] = {
                        "mtime": mt,
                        "tags": list(tags),
                        "deadline": deadline,
                        "wikilinks": wikilinks
                    }
                    cache_dirty = True

    # Purge deleted files from cache
    deleted = [k for k in cache if k not in valid_paths]
    if deleted:
        for k in deleted:
            cache.pop(k, None)
        cache_dirty = True

    if cache_dirty:
        save_cache(cache, cache_path)

    return cache


def find_project_file(vault_dir, project_path_or_name, data=None):
    """
    Resolves relative path or project title to absolute path in vault.
    First checks data.json project keys for instant resolution, falling back to filesystem checks.
    """
    clean_target = project_path_or_name.strip().replace("\\", "/").lower()
    if clean_target.endswith(".md"):
        clean_target_no_ext = clean_target[:-3]
    else:
        clean_target_no_ext = clean_target

    candidate_abs = os.path.join(vault_dir, project_path_or_name.replace("/", os.sep))
    if os.path.exists(candidate_abs) and os.path.isfile(candidate_abs):
        rel = os.path.relpath(candidate_abs, vault_dir).replace("\\", "/")
        return rel, candidate_abs

    if data:
        stats_projects = data.get("stats", {}).get("projects", {})
        candidates = []
        for rel_path in stats_projects.keys():
            rel_lower = rel_path.lower()
            title_lower = os.path.splitext(os.path.basename(rel_path))[0].lower()
            if rel_lower == clean_target or rel_lower == clean_target + ".md" or title_lower == clean_target_no_ext:
                abs_p = os.path.join(vault_dir, rel_path.replace("/", os.sep))
                if os.path.exists(abs_p):
                    return rel_path, abs_p
            if clean_target_no_ext in title_lower or clean_target_no_ext in rel_lower:
                abs_p = os.path.join(vault_dir, rel_path.replace("/", os.sep))
                if os.path.exists(abs_p):
                    candidates.append((rel_path, abs_p))
        if candidates:
            return candidates[0]

    return project_path_or_name, candidate_abs


def scan_projects(vault_dir, data, cache=None, fast_mode=False):
    """
    Reads active projects from data.json and unindexed project notes via fast cache.
    Matches Obsidian plugin rules:
    1. Must contain at least one tag in `settings.projectTags` (e.g. #todo).
    2. Must NOT contain `settings.archiveTag` or #done.
    Performs graph-based sub-project absorption based on [[wikilinks]].
    """
    if cache is None:
        cache = sync_vault_cache(vault_dir, fast_mode=fast_mode)

    stats_projects = data.get("stats", {}).get("projects", {})
    settings = data.get("settings", {})

    raw_tags = settings.get("projectTags", "todo, project")
    project_tags = [t.strip().lstrip("#").lower() for t in raw_tags.split(",") if t.strip()]

    archive_tag = settings.get("archiveTag", "done").strip().lstrip("#").lower()
    done_tags = {"done", "projet-fini", archive_tag}
    deadline_prop = settings.get("deadlineProperty", "deadline").lower()

    projects = []
    known_paths = set()

    # 1. Projects from data.json
    for rel_path, proj_stat in stats_projects.items():
        abs_path = os.path.join(vault_dir, rel_path.replace("/", os.sep))
        norm_rel = rel_path.replace("\\", "/")

        cached = cache.get(norm_rel)
        if cached:
            tags = set(cached.get("tags", []))
            deadline_str = cached.get("deadline", "")
            wikilinks = cached.get("wikilinks", [])
        else:
            if not os.path.exists(abs_path):
                continue
            fm, tags_set, _, _, wikilinks = parse_markdown_file(abs_path, parse_checkboxes=False)
            tags = tags_set
            deadline_str = str(fm.get(deadline_prop) or fm.get("deadline") or fm.get("due") or "")

        has_project_tag = any(pt in tags or any(t.startswith(pt + "/") for t in tags) for pt in project_tags)
        has_archive_tag = any(at in tags or any(t.startswith(at + "/") for t in tags) for at in done_tags)

        if not has_project_tag or has_archive_tag:
            continue

        total_reviews = int(proj_stat.get("totalReviews", 0))
        raw_score = proj_stat.get("currentScore")
        if total_reviews == 0 or raw_score is None:
            current_score = None
        else:
            current_score = float(raw_score)

        review_history = proj_stat.get("reviewHistory", [])
        last_action = review_history[-1].get("action") if review_history else ""

        # Skip finished projects
        if (current_score is not None and current_score == 0) or last_action == "finished":
            continue

        rotation_bonus = float(proj_stat.get("rotationBonus", 0.0))
        last_review_date = proj_stat.get("lastReviewDate", "")
        title = os.path.splitext(os.path.basename(rel_path))[0]

        deadline_urgency = 0.0
        if not deadline_str:
            deadline_str = proj_stat.get("deadline", "")

        if deadline_str and current_score is not None:
            try:
                d_date = datetime.strptime(deadline_str[:10], "%Y-%m-%d").date()
                today = datetime.now().date()
                days_left = (d_date - today).days
                p_factor = math.exp(-0.1 * days_left) if days_left > 0 else 1.0
                rem = 100.0 - (current_score + rotation_bonus)
                if rem > 0:
                    deadline_urgency = rem * p_factor
            except Exception:
                pass

        effective_score = (current_score + rotation_bonus + deadline_urgency) if current_score is not None else None

        known_paths.add(norm_rel)
        projects.append({
            "rel_path": norm_rel,
            "title": title,
            "base_score": current_score,
            "rotation_bonus": rotation_bonus,
            "deadline_urgency": deadline_urgency,
            "effective_score": effective_score,
            "deadline": deadline_str,
            "total_reviews": total_reviews,
            "last_review_date": last_review_date,
            "review_history": review_history,
            "full_path": abs_path,
            "wikilinks": wikilinks
        })

    # 2. Check unindexed active project notes from cache
    for rel_p, cached in cache.items():
        if rel_p in known_paths:
            continue
        tags = set(cached.get("tags", []))
        has_project_tag = any(pt in tags or any(t.startswith(pt + "/") for t in tags) for pt in project_tags)
        has_archive_tag = any(at in tags or any(t.startswith(at + "/") for t in tags) for at in done_tags)

        if has_project_tag and not has_archive_tag:
            abs_p = os.path.join(vault_dir, rel_p.replace("/", os.sep))
            title = os.path.splitext(os.path.basename(rel_p))[0]
            deadline_str = cached.get("deadline", "")
            wikilinks = cached.get("wikilinks", [])
            known_paths.add(rel_p)
            projects.append({
                "rel_path": rel_p,
                "title": title,
                "base_score": None,
                "rotation_bonus": 0.0,
                "deadline_urgency": 0.0,
                "effective_score": None,
                "deadline": deadline_str,
                "total_reviews": 0,
                "last_review_date": "",
                "review_history": [],
                "full_path": abs_p,
                "wikilinks": wikilinks
            })

    # 3. Graph-Based Sub-Project Absorption Logic
    cand_by_rel = {p["rel_path"]: p for p in projects}
    cand_by_title = {}
    for p in projects:
        rel_l = p["rel_path"].lower()
        title_l = p["title"].lower()
        cand_by_title[title_l] = p["rel_path"]
        cand_by_title[rel_l] = p["rel_path"]
        if rel_l.endswith(".md"):
            cand_by_title[rel_l[:-3]] = p["rel_path"]
        base_l = os.path.basename(rel_l)
        cand_by_title[base_l] = p["rel_path"]
        if base_l.endswith(".md"):
            cand_by_title[base_l[:-3]] = p["rel_path"]

    proj_children = {p["rel_path"]: set() for p in projects}
    proj_parents = {p["rel_path"]: set() for p in projects}

    for p in projects:
        for link_clean in p["wikilinks"]:
            target_rel = cand_by_title.get(link_clean) or cand_by_title.get(link_clean + ".md")
            if target_rel and target_rel != p["rel_path"]:
                proj_children[p["rel_path"]].add(target_rel)
                proj_parents[target_rel].add(p["rel_path"])

    root_candidates = [p for p in projects if not proj_parents[p["rel_path"]]]
    absorbed_paths = set()
    final_projects = []

    for root in root_candidates:
        r_rel = root["rel_path"]
        if r_rel in absorbed_paths:
            continue

        absorbed_sub_titles = []
        queue = list(proj_children[r_rel])
        seen_descendants = set()

        max_base_score = root["base_score"]
        earliest_deadline = root["deadline"]

        while queue:
            child_rel = queue.pop(0)
            if child_rel in seen_descendants or child_rel == r_rel:
                continue
            seen_descendants.add(child_rel)
            absorbed_paths.add(child_rel)

            child_proj = cand_by_rel[child_rel]
            absorbed_sub_titles.append(child_proj["title"])

            c_base = child_proj["base_score"]
            if c_base is not None:
                if max_base_score is None or c_base > max_base_score:
                    max_base_score = c_base

            c_dead = child_proj["deadline"]
            if c_dead:
                if not earliest_deadline or c_dead < earliest_deadline:
                    earliest_deadline = c_dead

            for grand_child in proj_children[child_rel]:
                if grand_child not in seen_descendants:
                    queue.append(grand_child)

        root["base_score"] = max_base_score
        root["deadline"] = earliest_deadline
        root["sub_projects"] = absorbed_sub_titles

        # Recalculate deadline urgency & effective score for root
        deadline_urgency = 0.0
        if earliest_deadline and max_base_score is not None:
            try:
                d_date = datetime.strptime(earliest_deadline[:10], "%Y-%m-%d").date()
                today = datetime.now().date()
                days_left = (d_date - today).days
                p_factor = math.exp(-0.1 * days_left) if days_left > 0 else 1.0
                rem = 100.0 - (max_base_score + root["rotation_bonus"])
                if rem > 0:
                    deadline_urgency = rem * p_factor
            except Exception:
                pass

        root["deadline_urgency"] = deadline_urgency
        root["effective_score"] = (max_base_score + root["rotation_bonus"] + deadline_urgency) if max_base_score is not None else None

        final_projects.append(root)

    # Handle remaining orphan/cycle project nodes that were neither root nor absorbed
    processed_paths = {p["rel_path"] for p in final_projects}.union(absorbed_paths)
    for p in projects:
        if p["rel_path"] not in processed_paths:
            p["sub_projects"] = []
            final_projects.append(p)
            processed_paths.add(p["rel_path"])

    # Sort matching Obsidian plugin review modal priority:
    # 1. Unreviewed projects (totalReviews == 0) first (alphabetical)
    # 2. Reviewed projects (totalReviews > 0) by effective score descending
    final_projects.sort(key=lambda p: (
        0 if p["total_reviews"] == 0 else 1,
        -p["effective_score"] if (p["total_reviews"] > 0 and p["effective_score"] is not None) else 0,
        p["title"].lower()
    ))
    return final_projects


def format_project_table(projects):
    lines = []
    header = f"{'Rank':<5} {'Title':<45} {'Eff.Score':<10} {'Base':<7} {'Rot.Bonus':<10} {'Deadline Urg.':<14} {'Deadline':<12} {'Reviews':<8}"
    lines.append(header)
    lines.append("-" * len(header))
    for idx, p in enumerate(projects, 1):
        title = p["title"]
        if p.get("sub_projects"):
            title += f" [🔗 inclut: {', '.join(p['sub_projects'])}]"
        if len(title) > 42:
            title = title[:39] + "..."
        rev_str = "NEW" if p["total_reviews"] == 0 else str(p["total_reviews"])
        eff_str = f"{p['effective_score']:.2f}" if p['effective_score'] is not None else "N/A"
        base_str = f"{p['base_score']:.1f}" if p['base_score'] is not None else "N/A"
        rot_str = f"{p['rotation_bonus']:.1f}" if p['rotation_bonus'] is not None else "0.0"
        urg_str = f"{p['deadline_urgency']:.2f}" if p['deadline_urgency'] is not None else "0.00"
        line = f"{idx:<5} {title:<45} {eff_str:<10} {base_str:<7} {rot_str:<10} {urg_str:<14} {p['deadline'] or 'N/A':<12} {rev_str:<8}"
        lines.append(line)
    return "\n".join(lines)


def cmd_list(args, data):
    fast_mode = getattr(args, "fast", False)
    projects = scan_projects(VAULT_DIR, data, fast_mode=fast_mode)
    top_n = getattr(args, "top", None)
    if top_n is None and getattr(args, "n", None) is not None:
        top_n = args.n

    unreviewed = [p for p in projects if p["total_reviews"] == 0]
    reviewed = [p for p in projects if p["total_reviews"] > 0]

    show_unreviewed_only = getattr(args, "unreviewed", False) or getattr(args, "new", False)
    show_reviewed_only = getattr(args, "reviewed", False)

    if show_unreviewed_only:
        unreviewed_disp = unreviewed[:top_n] if top_n is not None and top_n > 0 else unreviewed
        reviewed_disp = []
    elif show_reviewed_only:
        unreviewed_disp = []
        reviewed_disp = reviewed[:top_n] if top_n is not None and top_n > 0 else reviewed
    else:
        unreviewed_disp = unreviewed[:top_n] if top_n is not None and top_n > 0 else unreviewed
        reviewed_disp = reviewed[:top_n] if top_n is not None and top_n > 0 else reviewed

    if getattr(args, "json", False):
        if show_unreviewed_only:
            out = [dict(p, full_path=None) for p in unreviewed_disp]
            for cp in out: cp.pop("full_path", None)
            print(json.dumps(out, indent=2, ensure_ascii=False))
        elif show_reviewed_only:
            out = [dict(p, full_path=None) for p in reviewed_disp]
            for cp in out: cp.pop("full_path", None)
            print(json.dumps(out, indent=2, ensure_ascii=False))
        else:
            unrev_out = [dict(p, full_path=None) for p in unreviewed_disp]
            for cp in unrev_out: cp.pop("full_path", None)
            rev_out = [dict(p, full_path=None) for p in reviewed_disp]
            for cp in rev_out: cp.pop("full_path", None)
            print(json.dumps({
                "unreviewed": unrev_out,
                "reviewed": rev_out,
                "total_unreviewed": len(unreviewed),
                "total_reviewed": len(reviewed)
            }, indent=2, ensure_ascii=False))
    else:
        if show_unreviewed_only:
            print(f"=== 🆕 Unreviewed Projects ({len(unreviewed)} projects awaiting initial evaluation) ===")
            print(format_project_table(unreviewed_disp) if unreviewed_disp else "  (No unreviewed projects)")
        elif show_reviewed_only:
            print(f"=== 🔥 Reviewed Active Projects ({len(reviewed)} projects sorted by urgency) ===")
            print(format_project_table(reviewed_disp) if reviewed_disp else "  (No reviewed active projects)")
        else:
            print(f"=== 🆕 Unreviewed Projects ({len(unreviewed)} awaiting initial evaluation, showing {len(unreviewed_disp)}) ===")
            print(format_project_table(unreviewed_disp) if unreviewed_disp else "  (No unreviewed projects)")
            print()
            print(f"=== 🔥 Top Urgent Reviewed Projects ({len(reviewed)} active projects, showing {len(reviewed_disp)}) ===")
            print(format_project_table(reviewed_disp) if reviewed_disp else "  (No reviewed projects)")


def cmd_get(args, data):
    target = args.project_path
    rel_path, abs_path = find_project_file(VAULT_DIR, target, data)

    if not os.path.exists(abs_path):
        if getattr(args, "json", False):
            print(json.dumps({"error": f"Project note not found for '{target}'"}))
        else:
            print(f"Error: Project note file not found for '{target}'.")
        sys.exit(1)

    fm, tags, checkboxes, content, _ = parse_markdown_file(abs_path)
    stats = data.get("stats", {}).get("projects", {}).get(rel_path, {})
    deadline_prop = data.get("settings", {}).get("deadlineProperty", "deadline")

    total_reviews = int(stats.get("totalReviews", 0))
    raw_score = stats.get("currentScore")
    if total_reviews == 0 or raw_score is None:
        base_score = None
    else:
        base_score = float(raw_score)

    rotation_bonus = float(stats.get("rotationBonus", 0.0))
    deadline_val = fm.get(deadline_prop.lower()) or fm.get("deadline") or fm.get("due") or ""

    # Check absorbed sub-projects from scan_projects
    projects = scan_projects(VAULT_DIR, data)
    sub_projs = []
    for p in projects:
        if p["rel_path"] == rel_path or os.path.basename(p["rel_path"]) == os.path.basename(rel_path):
            sub_projs = p.get("sub_projects", [])
            break

    proj_info = {
        "rel_path": rel_path,
        "title": os.path.splitext(os.path.basename(rel_path))[0],
        "base_score": base_score,
        "rotation_bonus": rotation_bonus,
        "deadline_urgency": 0.0,
        "effective_score": (base_score + rotation_bonus) if base_score is not None else None,
        "deadline": str(deadline_val),
        "total_reviews": total_reviews,
        "last_review_date": stats.get("lastReviewDate", ""),
        "review_history": stats.get("reviewHistory", []),
        "sub_projects": sub_projs,
        "checkboxes": checkboxes,
        "frontmatter": fm,
        "tags": list(tags)
    }

    if getattr(args, "json", False):
        clean_p = dict(proj_info)
        clean_p.pop("full_path", None)
        print(json.dumps(clean_p, indent=2, ensure_ascii=False))
    else:
        print(f"=== Project Details: {proj_info['title']} ===")
        print(f"Path:             {proj_info['rel_path']}")
        if proj_info.get("sub_projects"):
            print(f"⚠️  🔗 INCLUT LES SOUS-PROJETS : {', '.join(proj_info['sub_projects'])}")
        eff_str = f"{proj_info['effective_score']:.2f}" if proj_info['effective_score'] is not None else "N/A"
        base_str = f"{proj_info['base_score']:.1f}" if proj_info['base_score'] is not None else "N/A"
        print(f"Effective Score:  {eff_str}")
        print(f"Base Score:       {base_str}")
        print(f"Rotation Bonus:   {proj_info['rotation_bonus']:.1f}")
        print(f"Deadline Urgency: {proj_info['deadline_urgency']:.2f}")
        print(f"Deadline:         {proj_info['deadline'] or 'N/A'}")
        print(f"Total Reviews:    {proj_info['total_reviews']}")
        print(f"Last Review Date: {proj_info['last_review_date'] or 'N/A'}")

        print("\n--- Review History ---")
        history = proj_info.get("review_history", [])
        if not history:
            print("No review history recorded yet.")
        else:
            for entry in history[-5:]:
                print(f"  [{entry.get('date', 'N/A')}] Action: {entry.get('action', 'N/A'):<12} Score After: {entry.get('scoreAfter', 0):.2f}")

        print("\n--- Roadmap Tasks ---")
        checkboxes = proj_info.get("checkboxes", [])
        pending = [c for c in checkboxes if not c["completed"]]
        completed = [c for c in checkboxes if c["completed"]]

        print(f"Pending Tasks ({len(pending)}):")
        if not pending:
            print("  (None)")
        else:
            for c in pending:
                print(f"  [ ] {c['text']} (line {c['line']})")

        print(f"Completed Tasks ({len(completed)}):")
        if not completed:
            print("  (None)")
        else:
            for c in completed:
                print(f"  [x] {c['text']} (line {c['line']})")


def update_note_frontmatter_archived(abs_path, settings):
    raw_tags = settings.get("projectTags", "todo, project")
    project_tags = [t.strip().lstrip("#").lower() for t in raw_tags.split(",") if t.strip()]
    archive_tag = settings.get("archiveTag", "done").strip().lstrip("#").lower()

    if not os.path.exists(abs_path):
        return

    with open(abs_path, "r", encoding="utf-8") as f:
        content = f.read()

    if content.startswith("---"):
        parts = content.split("---", 2)
        fm_raw = parts[1] if len(parts) >= 2 else ""
        body = parts[2] if len(parts) >= 3 else ""

        fm_lines = fm_raw.splitlines()
        new_fm_lines = []
        existing_tags = []
        in_tags_list = False

        for line in fm_lines:
            s = line.strip()
            if not s:
                continue
            if s.startswith("tags:"):
                v = s[5:].strip()
                if v.startswith("[") and v.endswith("]"):
                    items = [i.strip().strip('"\'').lstrip("#") for i in v[1:-1].split(",") if i.strip()]
                    existing_tags.extend(items)
                    in_tags_list = False
                elif v:
                    val_clean = v.strip('"\'').lstrip("#")
                    existing_tags.append(val_clean)
                    in_tags_list = False
                else:
                    in_tags_list = True
            elif in_tags_list:
                if s.startswith("- "):
                    t_val = s[2:].strip().strip('"\'').lstrip("#")
                    if t_val:
                        existing_tags.append(t_val)
                elif ":" in s:
                    in_tags_list = False
                    new_fm_lines.append(line)
            else:
                new_fm_lines.append(line)

        final_tags = []
        for t in existing_tags:
            if t.lower() not in project_tags and t.lower() not in [ft.lower() for ft in final_tags]:
                final_tags.append(t)
        if archive_tag not in [ft.lower() for ft in final_tags]:
            final_tags.append(archive_tag)

        tags_line = f"tags: [{', '.join(final_tags)}]"
        new_fm_lines.insert(0, tags_line)

        body_prefix = "" if body.startswith("\n") else "\n"
        new_content = "---\n" + "\n".join(new_fm_lines) + "\n---" + body_prefix + body
    else:
        new_fm = f"---\ntags: [{archive_tag}]\n---\n\n"
        new_content = new_fm + content

    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(new_content)
    print(f"Updated note frontmatter tags for '{abs_path}' (archived with tag '{archive_tag}').")


def strip_project_tags(abs_path, settings):
    raw_tags = settings.get("projectTags", "todo, project")
    project_tags = [t.strip().lstrip("#").lower() for t in raw_tags.split(",") if t.strip()]

    if not os.path.exists(abs_path):
        return

    with open(abs_path, "r", encoding="utf-8") as f:
        content = f.read()

    if content.startswith("---"):
        parts = content.split("---", 2)
        fm_raw = parts[1] if len(parts) >= 2 else ""
        body = parts[2] if len(parts) >= 3 else ""

        fm_lines = fm_raw.splitlines()
        new_fm_lines = []
        existing_tags = []
        in_tags_list = False

        for line in fm_lines:
            s = line.strip()
            if not s:
                continue
            if s.startswith("tags:"):
                v = s[5:].strip()
                if v.startswith("[") and v.endswith("]"):
                    items = [i.strip().strip('"\'').lstrip("#") for i in v[1:-1].split(",") if i.strip()]
                    existing_tags.extend(items)
                    in_tags_list = False
                elif v:
                    val_clean = v.strip('"\'').lstrip("#")
                    existing_tags.append(val_clean)
                    in_tags_list = False
                else:
                    in_tags_list = True
            elif in_tags_list:
                if s.startswith("- "):
                    t_val = s[2:].strip().strip('"\'').lstrip("#")
                    if t_val:
                        existing_tags.append(t_val)
                elif ":" in s:
                    in_tags_list = False
                    new_fm_lines.append(line)
            else:
                new_fm_lines.append(line)

        final_tags = [t for t in existing_tags if t.lower() not in project_tags]
        if final_tags:
            tags_line = f"tags: [{', '.join(final_tags)}]"
            new_fm_lines.insert(0, tags_line)

        # Also strip inline project tags from body
        for pt in project_tags:
            body = re.sub(rf'(?i)(^|\s)#{re.escape(pt)}\b', r'\1', body)

        body_prefix = "" if body.startswith("\n") else "\n"
        new_content = "---\n" + "\n".join(new_fm_lines) + "\n---" + body_prefix + body
    else:
        new_content = content
        for pt in project_tags:
            new_content = re.sub(rf'(?i)(^|\s)#{re.escape(pt)}\b', r'\1', new_content)

    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(new_content)
    print(f"Updated note frontmatter for '{abs_path}' (stripped project tags, marked as non-projet).")


def apply_feedback(project_path, action, worked, data):
    stats = data.setdefault("stats", {}).setdefault("projects", {})
    global_stats = data.setdefault("stats", {}).setdefault("globalStats", {"totalReviews": 0, "totalPomodoroTime": 0})
    settings = data.setdefault("settings", {})

    rel_path, abs_path = find_project_file(VAULT_DIR, project_path, data)

    matched_key = None
    for k in stats.keys():
        if k == rel_path or os.path.basename(k) == os.path.basename(rel_path) or k.endswith(rel_path):
            matched_key = k
            break
    if not matched_key:
        matched_key = rel_path

    if matched_key not in stats:
        proj = {
            "rotationBonus": 0.0,
            "totalReviews": 0,
            "lastReviewDate": "",
            "reviewHistory": []
        }
        stats[matched_key] = proj
    else:
        proj = stats[matched_key]

    total_reviews = int(proj.get("totalReviews", 0))
    raw_score = proj.get("currentScore")
    current_score = float(raw_score) if (total_reviews > 0 and raw_score is not None) else None

    rf = float(settings.get("rapprochementFactor") or settings.get("rapprochmentFactor") or 0.2)
    act = action.lower()

    try:
        new_score = float(act)
    except ValueError:
        if act in ("finished", "non-projet", "non_projet", "non-project", "not-a-project"):
            new_score = 0.0
        else:
            baseline = current_score if current_score is not None else 50.0
            if act == "less-often":
                new_score = baseline - rf * (baseline - 1.0)
            elif act == "ok":
                new_score = baseline
            elif act in ("more-often", "emergency"):
                new_score = baseline + rf * (100.0 - baseline)
            else:
                raise ValueError(f"Unknown action '{action}'. Options: ok, less-often, more-often, finished, emergency, non-projet, or numeric score (1-100).")

    if act not in ("finished", "non-projet", "non_projet", "non-project", "not-a-project"):
        new_score = max(1.0, min(100.0, new_score))

    proj["currentScore"] = round(new_score, 3)
    now_iso = datetime.now(timezone.utc).isoformat()
    proj["lastReviewDate"] = now_iso
    proj["totalReviews"] = total_reviews + 1

    if worked:
        rot_inc = float(settings.get("rotationBonus", 0.1))
        for p_key, p_val in stats.items():
            if p_key != matched_key:
                p_val["rotationBonus"] = float(p_val.get("rotationBonus", 0.0)) + rot_inc

        proj["rotationBonus"] = 0.0
        global_stats["totalReviews"] = global_stats.get("totalReviews", 0) + 1

    proj.setdefault("reviewHistory", []).append({
        "date": now_iso,
        "action": act,
        "scoreAfter": round(new_score, 3)
    })

    if len(proj.get("reviewHistory", [])) > 100:
        proj["reviewHistory"] = proj["reviewHistory"][-100:]

    data_path = os.path.join(VAULT_DIR, ".obsidian", "plugins", "project-memory", "data.json")

    # Invalidate cache entry for the modified file
    cache = load_cache()
    norm_rel = rel_path.replace("\\", "/")

    if act == "finished":
        update_note_frontmatter_archived(abs_path, settings)
        stats.pop(matched_key, None)
        save_data(data, data_path)
        if norm_rel in cache:
            cache.pop(norm_rel, None)
            save_cache(cache)
        print(f"Feedback saved for '{matched_key}': action='finished', project purged from data.json")
        return matched_key, 0.0

    if act in ("non-projet", "non_projet", "non-project", "not-a-project"):
        strip_project_tags(abs_path, settings)
        stats.pop(matched_key, None)
        save_data(data, data_path)
        if norm_rel in cache:
            cache.pop(norm_rel, None)
            save_cache(cache)
        print(f"Feedback saved for '{matched_key}': action='non-projet', project stripped of tags and purged from active projects.")
        return matched_key, 0.0

    save_data(data, data_path)
    print(f"Feedback saved for '{matched_key}': action='{act}', new_score={new_score:.2f}, worked={worked}")
    return matched_key, new_score


def cmd_feedback(args, data):
    action = getattr(args, "action", None) or getattr(args, "pos_action", None)
    if not action:
        print("Error: Action is required. Use --action <action> or pass action as positional argument.")
        print("Options: ok, less-often, more-often, finished, emergency, non-projet, or numeric score (1-100)")
        sys.exit(1)

    apply_feedback(args.project_path, action, getattr(args, "worked", False), data)


def cmd_set_score(args, data):
    apply_feedback(args.project_path, str(args.score), getattr(args, "worked", False), data)


def cmd_complete_task(args, data):
    target = args.project_path
    task_text = args.task_text.strip()

    rel_path, abs_path = find_project_file(VAULT_DIR, target, data)

    if not os.path.exists(abs_path):
        print(f"Error: Project note file not found for '{target}'.")
        sys.exit(1)

    with open(abs_path, "r", encoding="utf-8") as f:
        content = f.read()

    lines = content.splitlines()
    found = False
    new_lines = []

    for line in lines:
        if not found and re.match(r'^\s*[-*+]\s+\[ \]\s+', line):
            if task_text.lower() in line.lower():
                line = re.sub(r'(\s*[-*+]\s+)\[ \]', r'\1[x]', line, count=1)
                found = True
                print(f"Checked task in '{rel_path}': {line.strip()}")
        new_lines.append(line)

    if not found:
        print(f"Warning: Pending task matching '{task_text}' not found in '{rel_path}'.")
        print("Available pending tasks:")
        _, _, checkboxes, _, _ = parse_markdown_file(abs_path)
        pending = [c for c in checkboxes if not c["completed"]]
        if not pending:
            print("  (No pending tasks found in file)")
        else:
            for p in pending:
                print(f"  - [ ] {p['text']}")
        sys.exit(1)

    with open(abs_path, "w", encoding="utf-8") as f:
        f.write("\n".join(new_lines) + "\n")

    apply_feedback(target, "ok", worked=True, data=data)


def cmd_work(args, data):
    rel_path, abs_path = find_project_file(VAULT_DIR, args.project_path, data)
    if not os.path.exists(abs_path):
        print(f"Error: Project note file not found for '{args.project_path}'.", flush=True)
        sys.exit(1)

    stats = data.setdefault("stats", {}).setdefault("projects", {})
    global_stats = data.setdefault("stats", {}).setdefault("globalStats", {"totalReviews": 0, "totalPomodoroTime": 0})
    settings = data.setdefault("settings", {})

    matched_key = None
    for k in stats.keys():
        if k == rel_path or os.path.basename(k) == os.path.basename(rel_path) or k.endswith(rel_path):
            matched_key = k
            break
    if not matched_key:
        matched_key = rel_path

    if matched_key not in stats:
        proj = {
            "rotationBonus": 0.0,
            "totalReviews": 0,
            "lastReviewDate": "",
            "reviewHistory": []
        }
        stats[matched_key] = proj
    else:
        proj = stats[matched_key]

    # Apply immediate rotation bonus upon starting work session
    rot_inc = float(settings.get("rotationBonus", 0.1))
    for p_key, p_val in stats.items():
        if p_key != matched_key:
            p_val["rotationBonus"] = round(float(p_val.get("rotationBonus", 0.0)) + rot_inc, 3)

    proj["rotationBonus"] = 0.0

    duration_min = args.duration if args.duration is not None else data.get("settings", {}).get("pomodoroDuration", 25)
    total_seconds = duration_min * 60
    global_stats["totalPomodoroTime"] = global_stats.get("totalPomodoroTime", 0) + duration_min

    data_path = os.path.join(VAULT_DIR, ".obsidian", "plugins", "project-memory", "data.json")
    save_data(data, data_path)

    title = os.path.splitext(os.path.basename(rel_path))[0]
    print(f"🔄 Rotation appliquée dans data.json (+{rot_inc:.1f} aux autres projets, réinitialisé à 0.0 pour '{title}').", flush=True)
    print(f"⏱️ Session Pomodoro démarrée pour '{title}' ({duration_min} min)...", flush=True)
    step_sec = 30
    for elapsed_sec in range(0, total_seconds + 1, step_sec):
        remaining_sec = max(0, total_seconds - elapsed_sec)
        remaining_min = math.ceil(remaining_sec / 60)
        pct = int((elapsed_sec / total_seconds) * 100) if total_seconds > 0 else 100
        bar_len = 15
        filled = int(bar_len * elapsed_sec / total_seconds) if total_seconds > 0 else bar_len
        bar = "█" * filled + "░" * (bar_len - filled)
        m_rem = remaining_sec // 60
        s_rem = remaining_sec % 60
        print(f"⏳ [{bar}] {pct:3d}% | Temps restant : {m_rem:02d}:{s_rem:02d} ({remaining_min} min)", flush=True)
        if remaining_sec > 0:
            time.sleep(min(step_sec, remaining_sec))

    all_projects = scan_projects(VAULT_DIR, data)
    other_projects = [
        p for p in all_projects
        if p["rel_path"] != rel_path and p["full_path"] != abs_path and p["title"] != title
    ]
    other_projects.sort(key=lambda p: -p["effective_score"] if p.get("effective_score") is not None else 0)
    top3 = other_projects[:3]

    print("============================================================", flush=True)
    print(f"🎉 POMODORO TERMINÉ pour '{title}' ({duration_min} min)", flush=True)
    print("============================================================", flush=True)
    print(flush=True)
    print("CONSIGNES ANTIGRAVITY POST-POMODORO :", flush=True)
    print(f"1. Mentionner à Henri que le travail sur '{title}' est terminé et l'encourager à faire une pause de 5 minutes.", flush=True)
    print("2. Évaluation autonome de l'urgence par Antigravity (Strict Anti-Biais d'optimisme & Marge de sécurité) :", flush=True)
    print("   - Mesurer si le rythme actuel garantit de respecter l'échéance avec une marge de sécurité.", flush=True)
    print("   - Appliquer le feedback approprié via CLI :", flush=True)
    print("     - 'ok' (Rythme sous contrôle / adapté)", flush=True)
    print("     - 'more-often' / 'emergency' (Sous-priorisé / Pression élevée / Risque de retard)", flush=True)
    print("     - 'less-often' (Rythme excessif / Priorité basse)", flush=True)
    print("   - Communiquer la décision et sa justification à Henri et lui permettre de contester.", flush=True)
    print("3. Proposer à Henri d'enchaîner sur l'un des 3 projets les plus urgents suivants :", flush=True)
    if not top3:
        print("   (Aucun autre projet actif)", flush=True)
    else:
        for idx, p in enumerate(top3, 1):
            deadline_info = f" - Deadline: {p['deadline']}" if p.get("deadline") else ""
            eff_info = f"{p['effective_score']:.2f}" if p.get("effective_score") is not None else "N/A"
            print(f"   {idx}. {p['title']} (Score effectif: {eff_info}{deadline_info})", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Project Memory CLI")
    subparsers = parser.add_subparsers(dest="command", help="Sub-commands")

    # list
    list_parser = subparsers.add_parser("list", help="List active projects sorted by score")
    list_parser.add_argument("--top", "-n", type=int, help="Limit output to top N projects")
    list_parser.add_argument("--json", action="store_true", help="Output in JSON format")
    list_parser.add_argument("--unreviewed", "--new", action="store_true", help="List only unreviewed projects awaiting initial evaluation")
    list_parser.add_argument("--reviewed", action="store_true", help="List only evaluated/reviewed projects sorted by score")
    list_parser.add_argument("--fast", action="store_true", help="Fast mode using existing cache without filesystem scan")

    # get
    get_parser = subparsers.add_parser("get", help="Get project details and roadmap tasks")
    get_parser.add_argument("project_path", help="Relative path or name of project note")
    get_parser.add_argument("--json", action="store_true", help="Output in JSON format")

    # feedback
    fb_parser = subparsers.add_parser("feedback", help="Log review feedback for a project")
    fb_parser.add_argument("project_path", help="Relative path or name of project note")
    fb_parser.add_argument("pos_action", nargs="?", help="Action: ok, less-often, more-often, finished, emergency, non-projet")
    fb_parser.add_argument("--action", "-a", help="Action to perform")
    fb_parser.add_argument("--worked", "-w", action="store_true", help="Set if user worked on the project")

    # complete-task
    comp_parser = subparsers.add_parser("complete-task", help="Check off a task in a project note")
    comp_parser.add_argument("project_path", help="Relative path or name of project note")
    comp_parser.add_argument("task_text", help="Text snippet of the task to mark completed")

    # set-score
    set_score_parser = subparsers.add_parser("set-score", help="Set explicit urgency score (1-100) for a project")
    set_score_parser.add_argument("project_path", help="Relative path or name of project note")
    set_score_parser.add_argument("score", type=float, help="Explicit score between 1.0 and 100.0")
    set_score_parser.add_argument("--worked", "-w", action="store_true", help="Set if user worked on the project")

    # work
    work_parser = subparsers.add_parser("work", help="Démarre une session Pomodoro active sur un projet")
    work_parser.add_argument("project_path", help="Chemin relatif ou nom du projet")
    work_parser.add_argument("--duration", "-d", type=int, help="Durée en minutes (défaut : pomodoroDuration de data.json)")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    data = load_data(DATA_JSON_PATH)

    if args.command == "list":
        cmd_list(args, data)
    elif args.command == "get":
        cmd_get(args, data)
    elif args.command == "feedback":
        cmd_feedback(args, data)
    elif args.command == "set-score":
        cmd_set_score(args, data)
    elif args.command == "complete-task":
        cmd_complete_task(args, data)
    elif args.command == "work":
        cmd_work(args, data)


if __name__ == "__main__":
    main()
