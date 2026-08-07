#!/usr/bin/env python3
"""
Project Memory CLI
------------------
CLI interface for Obsidian project-memory plugin.
Calculates project scores, lists urgent tasks, logs session feedback,
extracts roadmap checkboxes, and completes tasks.
Reuses canonical Obsidian plugin logic and data structures.
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

EXCLUDED_DIRS = {
    ".obsidian", ".git", ".trash", ".claude", ".cursor",
    ".smart-env", ".pytest_cache", "attachments", "thumbnails",
    "excalidraw", "antigravity", "voicenotes", "readwise"
}

DEFAULT_SETTINGS = {
    "projectTags": "todo, project",
    "defaultScore": 100,
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


def parse_markdown_file(file_path, content=None, parse_checkboxes=True):
    """
    Parses a markdown file for frontmatter, tags, checkboxes, and content.
    Returns: (frontmatter_dict, tags_set, checkboxes_list, content_str)
    """
    try:
        if content is None:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
    except Exception:
        return {}, set(), [], ""

    frontmatter = {}
    tags = set()
    checkboxes = []

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
                    v_str = v.strip().strip('"\'')
                    frontmatter[k_str] = v_str
                    if k_str in ("tags", "tag"):
                        in_tags = True
                        if v_str.startswith("[") and v_str.endswith("]"):
                            items = v_str[1:-1].split(",")
                            for item in items:
                                t = item.strip().strip('"\'').lstrip("#")
                                if t:
                                    tags.add(t.lower())
                            in_tags = False
                        elif v_str:
                            items = v_str.split(",")
                            for item in items:
                                t = item.strip().strip('"\'').lstrip("#")
                                if t:
                                    tags.add(t.lower())
                            in_tags = False
                elif in_tags and stripped.startswith("-"):
                    t = stripped[1:].strip().strip('"\'').lstrip("#")
                    if t:
                        tags.add(t.lower())
                elif not stripped.startswith("-"):
                    in_tags = False

    # Inline tags `#tag`
    inline_tags = re.findall(r'(?:^|[^\w#])#([a-zA-Z0-9_\-\/]+)', content)
    for tag in inline_tags:
        tags.add(tag.lower())

    # Checkboxes
    if parse_checkboxes:
        for idx, line in enumerate(body_lines, 1):
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

    return frontmatter, tags, checkboxes, content


def find_project_file(vault_dir, project_path_or_name, data=None):
    """
    Resolves relative path or project title to absolute path in vault.
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

    for root, dirs, files in os.walk(vault_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d.lower() not in EXCLUDED_DIRS]
        for file in files:
            if file.endswith(".md"):
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, vault_dir).replace("\\", "/")
                title = os.path.splitext(file)[0]
                if (rel_path.lower() == clean_target or
                        rel_path.lower() == clean_target + ".md" or
                        title.lower() == clean_target_no_ext):
                    return rel_path, full_path

    for root, dirs, files in os.walk(vault_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d.lower() not in EXCLUDED_DIRS]
        for file in files:
            if file.endswith(".md"):
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, vault_dir).replace("\\", "/")
                title = os.path.splitext(file)[0]
                if clean_target_no_ext in title.lower() or clean_target_no_ext in rel_path.lower():
                    return rel_path, full_path

    return project_path_or_name, candidate_abs


def scan_projects(vault_dir, data):
    """
    Reads active projects directly from data.json (stats.projects) and matches Obsidian plugin logic:
    1. Must contain at least one tag in `settings.projectTags` (e.g. #todo).
    2. Must NOT contain `settings.archiveTag` or #done.
    """
    stats_projects = data.get("stats", {}).get("projects", {})
    settings = data.get("settings", {})
    default_score = float(settings.get("defaultScore", 100))

    raw_tags = settings.get("projectTags", "todo, project")
    project_tags = [t.strip().lstrip("#").lower() for t in raw_tags.split(",") if t.strip()]

    archive_tag = settings.get("archiveTag", "done").strip().lstrip("#").lower()
    done_tags = {"done", "projet-fini", archive_tag}
    deadline_prop = settings.get("deadlineProperty", "deadline").lower()

    projects = []

    for rel_path, proj_stat in stats_projects.items():
        abs_path = os.path.join(vault_dir, rel_path.replace("/", os.sep))

        if not os.path.exists(abs_path):
            continue

        fm, tags, _, _ = parse_markdown_file(abs_path, parse_checkboxes=False)

        # Strict tag verification matching Obsidian plugin
        has_project_tag = any(pt in tags or any(t.startswith(pt + "/") for t in tags) for pt in project_tags)
        has_archive_tag = any(at in tags or any(t.startswith(at + "/") for t in tags) for at in done_tags)

        if not has_project_tag or has_archive_tag:
            continue

        current_score = float(proj_stat.get("currentScore", default_score))
        review_history = proj_stat.get("reviewHistory", [])
        last_action = review_history[-1].get("action") if review_history else ""

        # Skip finished projects
        if current_score == 0 or last_action == "finished":
            continue

        rotation_bonus = float(proj_stat.get("rotationBonus", 0.0))
        total_reviews = int(proj_stat.get("totalReviews", 0))
        last_review_date = proj_stat.get("lastReviewDate", "")

        title = os.path.splitext(os.path.basename(rel_path))[0]

        deadline_urgency = 0.0
        deadline_str = proj_stat.get("deadline", "")

        if not deadline_str:
            deadline_val = fm.get(deadline_prop) or fm.get("deadline") or fm.get("due")
            if deadline_val:
                deadline_str = str(deadline_val).strip()

        if deadline_str:
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

        effective_score = current_score + rotation_bonus + deadline_urgency

        projects.append({
            "rel_path": rel_path,
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
        })

    # Also scan Projects/ folder for any newly added active project notes
    projects_dir = os.path.join(vault_dir, "Projects")
    known_paths = {p["rel_path"] for p in projects}
    if os.path.exists(projects_dir):
        for file in os.listdir(projects_dir):
            if file.endswith(".md"):
                abs_p = os.path.join(projects_dir, file)
                rel_p = os.path.relpath(abs_p, vault_dir).replace("\\", "/")
                if rel_p in known_paths:
                    continue
                fm, tags, checkboxes, _ = parse_markdown_file(abs_p, parse_checkboxes=True)
                has_project_tag = any(pt in tags or any(t.startswith(pt + "/") for t in tags) for pt in project_tags)
                has_archive_tag = any(at in tags or any(t.startswith(at + "/") for t in tags) for at in done_tags)
                if has_project_tag and not has_archive_tag:
                    title = os.path.splitext(file)[0]
                    projects.append({
                        "rel_p": rel_p,
                        "title": title,
                        "base_score": default_score,
                        "rotation_bonus": 0.0,
                        "deadline_urgency": 0.0,
                        "effective_score": default_score,
                        "deadline": str(fm.get("due") or fm.get("deadline") or ""),
                        "total_reviews": 0,
                        "last_review_date": "",
                        "review_history": [],
                        "full_path": abs_p,
                    })

    # Sort matching Obsidian plugin review modal priority:
    projects.sort(key=lambda p: (
        0 if p["total_reviews"] == 0 else 1,
        -p["effective_score"] if p["total_reviews"] > 0 else 0,
        p["title"].lower()
    ))
    return projects


def format_project_table(projects):
    lines = []
    header = f"{'Rank':<5} {'Title':<45} {'Eff.Score':<10} {'Base':<7} {'Rot.Bonus':<10} {'Deadline Urg.':<14} {'Deadline':<12} {'Reviews':<8}"
    lines.append(header)
    lines.append("-" * len(header))
    for idx, p in enumerate(projects, 1):
        title = p["title"]
        if len(title) > 42:
            title = title[:39] + "..."
        rev_str = "NEW" if p["total_reviews"] == 0 else str(p["total_reviews"])
        line = f"{idx:<5} {title:<45} {p['effective_score']:<10.2f} {p['base_score']:<7.1f} {p['rotation_bonus']:<10.1f} {p['deadline_urgency']:<14.2f} {p['deadline'] or 'N/A':<12} {rev_str:<8}"
        lines.append(line)
    return "\n".join(lines)


def cmd_list(args, data):
    projects = scan_projects(VAULT_DIR, data)
    top_n = getattr(args, "top", None)
    if top_n is None and getattr(args, "n", None) is not None:
        top_n = args.n

    if top_n is not None and top_n > 0:
        projects = projects[:top_n]

    if getattr(args, "json", False):
        clean_proj = []
        for p in projects:
            cp = dict(p)
            cp.pop("full_path", None)
            clean_proj.append(cp)
        print(json.dumps(clean_proj, indent=2, ensure_ascii=False))
    else:
        print(f"=== Project Memory List ({len(projects)} active projects) ===")
        print(format_project_table(projects))


def cmd_get(args, data):
    target = args.project_path
    rel_path, abs_path = find_project_file(VAULT_DIR, target)

    if not os.path.exists(abs_path):
        if getattr(args, "json", False):
            print(json.dumps({"error": f"Project note not found for '{target}'"}))
        else:
            print(f"Error: Project note file not found for '{target}'.")
        sys.exit(1)

    all_projects = scan_projects(VAULT_DIR, data)
    proj_info = None
    for p in all_projects:
        if p["rel_path"] == rel_path or p["full_path"] == abs_path:
            proj_info = p
            break

    if not proj_info:
        fm, tags, checkboxes, content = parse_markdown_file(abs_path)
        stats = data.get("stats", {}).get("projects", {}).get(rel_path, {})
        proj_info = {
            "rel_path": rel_path,
            "title": os.path.splitext(os.path.basename(rel_path))[0],
            "base_score": float(stats.get("currentScore", data.get("settings", {}).get("defaultScore", 100))),
            "rotation_bonus": float(stats.get("rotationBonus", 0.0)),
            "deadline_urgency": 0.0,
            "effective_score": float(stats.get("currentScore", 100)) + float(stats.get("rotationBonus", 0.0)),
            "deadline": str(fm.get("deadline") or fm.get("due") or ""),
            "total_reviews": stats.get("totalReviews", 0),
            "last_review_date": stats.get("lastReviewDate", ""),
            "review_history": stats.get("reviewHistory", []),
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
        print(f"Effective Score:  {proj_info['effective_score']:.2f}")
        print(f"Base Score:       {proj_info['base_score']:.1f}")
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
    archive_tag = settings.get("archiveTag", "done").strip().lstrip("#")

    if not os.path.exists(abs_path):
        return

    with open(abs_path, "r", encoding="utf-8") as f:
        content = f.read()

    new_tags = [archive_tag]

    if content.startswith("---"):
        parts = content.split("---", 2)
        fm_raw = parts[1]
        body = parts[2] if len(parts) >= 3 else ""

        new_fm_lines = []
        has_tags_field = False
        in_tags_list = False
        for line in fm_raw.splitlines():
            s = line.strip()
            if s.startswith("tags:"):
                has_tags_field = True
                v = s[5:].strip()
                if v.startswith("[") and v.endswith("]"):
                    items = [i.strip().strip('"\'').lstrip("#") for i in v[1:-1].split(",") if i.strip()]
                    filtered = [i for i in items if i.lower() not in project_tags]
                    if archive_tag not in filtered:
                        filtered.append(archive_tag)
                    new_fm_lines.append(f"tags: [{', '.join(filtered)}]")
                    in_tags_list = False
                elif v:
                    val_clean = v.strip('"\'').lstrip("#")
                    if val_clean.lower() not in project_tags:
                        new_tags.append(val_clean)
                    new_fm_lines.append(f"tags: [{', '.join(dict.fromkeys(new_tags))}]")
                    in_tags_list = False
                else:
                    in_tags_list = True
            elif in_tags_list:
                if s.startswith("- "):
                    t_val = s[2:].strip().strip('"\'').lstrip("#")
                    if t_val.lower() not in project_tags:
                        new_tags.append(t_val)
                elif ":" in s or not s:
                    in_tags_list = False
                    new_fm_lines.append(line)
            else:
                new_fm_lines.append(line)

        if not has_tags_field:
            new_fm_lines.append(f"tags: [{', '.join(dict.fromkeys(new_tags))}]")

        new_content = "---" + "\n".join(new_fm_lines) + "\n---" + body
    else:
        new_fm = f"---\ntags:\n  - {archive_tag}\n---\n\n"
        new_content = new_fm + content

    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(new_content)
    print(f"Updated note frontmatter tags for '{abs_path}' (archived with tag '{archive_tag}').")


def apply_feedback(project_path, action, worked, data):
    stats = data.setdefault("stats", {}).setdefault("projects", {})
    global_stats = data.setdefault("stats", {}).setdefault("globalStats", {"totalReviews": 0, "totalPomodoroTime": 0})
    settings = data.setdefault("settings", {})

    rel_path, abs_path = find_project_file(VAULT_DIR, project_path)

    matched_key = None
    for k in stats.keys():
        if k == rel_path or os.path.basename(k) == os.path.basename(rel_path) or k.endswith(rel_path):
            matched_key = k
            break
    if not matched_key:
        matched_key = rel_path

    proj = stats.setdefault(matched_key, {
        "currentScore": float(settings.get("defaultScore", 100)),
        "rotationBonus": 0.0,
        "totalReviews": 0,
        "lastReviewDate": "",
        "reviewHistory": []
    })

    current_score = float(proj.get("currentScore", settings.get("defaultScore", 100)))
    rf = float(settings.get("rapprochementFactor") or settings.get("rapprochmentFactor") or 0.2)
    act = action.lower()

    if act == "less-often":
        new_score = current_score - rf * (current_score - 1.0)
    elif act == "ok":
        new_score = current_score
    elif act in ("more-often", "emergency"):
        new_score = current_score + rf * (100.0 - current_score)
    elif act == "finished":
        new_score = 0.0
    else:
        raise ValueError(f"Unknown action '{action}'. Options: ok, less-often, more-often, finished, emergency.")

    if act != "finished":
        new_score = max(1.0, min(100.0, new_score))

    is_new = (proj.get("totalReviews", 0) == 0)

    if not (is_new and not worked):
        proj["currentScore"] = round(new_score, 3)

    now_iso = datetime.now(timezone.utc).isoformat()

    if is_new and not worked:
        proj["totalReviews"] = 1
    elif worked:
        rot_inc = float(settings.get("rotationBonus", 0.1))
        for p_key, p_val in stats.items():
            if p_key != matched_key:
                p_val["rotationBonus"] = float(p_val.get("rotationBonus", 0.0)) + rot_inc

        proj["rotationBonus"] = 0.0
        proj["totalReviews"] = proj.get("totalReviews", 0) + 1
        proj["lastReviewDate"] = now_iso
        global_stats["totalReviews"] = global_stats.get("totalReviews", 0) + 1
        proj.setdefault("reviewHistory", []).append({
            "date": now_iso,
            "action": act,
            "scoreAfter": round(new_score, 3)
        })
    else:
        proj.setdefault("reviewHistory", []).append({
            "date": now_iso,
            "action": act,
            "scoreAfter": round(new_score, 3)
        })

    if len(proj.get("reviewHistory", [])) > 100:
        proj["reviewHistory"] = proj["reviewHistory"][-100:]

    save_data(data)
    print(f"Feedback saved for '{matched_key}': action='{act}', new_score={new_score:.2f}, worked={worked}")

    if act == "finished":
        update_note_frontmatter_archived(abs_path, settings)

    return matched_key, new_score


def cmd_feedback(args, data):
    action = getattr(args, "action", None) or getattr(args, "pos_action", None)
    if not action:
        print("Error: Action is required. Use --action <action> or pass action as positional argument.")
        print("Options: ok, less-often, more-often, finished, emergency")
        sys.exit(1)

    apply_feedback(args.project_path, action, getattr(args, "worked", False), data)


def cmd_complete_task(args, data):
    target = args.project_path
    task_text = args.task_text.strip()

    rel_path, abs_path = find_project_file(VAULT_DIR, target)

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
        _, _, checkboxes, _ = parse_markdown_file(abs_path)
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
        print(f"Error: Project note file not found for '{args.project_path}'.")
        sys.exit(1)

    duration = args.duration if args.duration else data.get("settings", {}).get("pomodoroDuration", 25)
    title = os.path.splitext(os.path.basename(rel_path))[0]

    print(f"⏱️ Session Pomodoro démarrée pour '{title}' ({duration} min)...")
    for remaining in range(duration, 0, -1):
        print(f"⏳ Temps restant : {remaining} min")
        time.sleep(60)

    all_projects = scan_projects(VAULT_DIR, data)
    other_projects = [
        p for p in all_projects
        if p["rel_path"] != rel_path and p["full_path"] != abs_path and p["title"] != title
    ]
    other_projects.sort(key=lambda p: -p["effective_score"])
    top3 = other_projects[:3]

    print("============================================================")
    print(f"🎉 POMODORO TERMINÉ pour '{title}' ({duration} min)")
    print("============================================================")
    print()
    print("CONSIGNES ANTIGRAVITY POST-POMODORO :")
    print(f"1. Mentionner à Henri que le travail sur '{title}' est terminé et l'encourager à faire une pause de 5 minutes.")
    print("2. Évaluation autonome de l'urgence par Antigravity (Strict Anti-Biais d'optimisme & Marge de sécurité) :")
    print("   - Mesurer si le rythme actuel garantit de respecter l'échéance avec une marge de sécurité.")
    print("   - Appliquer le feedback approprié via CLI :")
    print("     - 'ok' (Rythme sous contrôle / adapté)")
    print("     - 'more-often' / 'emergency' (Sous-priorisé / Pression élevée / Risque de retard)")
    print("     - 'less-often' (Rythme excessif / Priorité basse)")
    print("   - Communiquer la décision et sa justification à Henri et lui permettre de contester.")
    print("3. Proposer à Henri d'enchaîner sur l'un des 3 projets les plus urgents suivants :")
    if not top3:
        print("   (Aucun autre projet actif)")
    else:
        for idx, p in enumerate(top3, 1):
            deadline_info = f" - Deadline: {p['deadline']}" if p.get("deadline") else ""
            print(f"   {idx}. {p['title']} (Score effectif: {p['effective_score']:.2f}{deadline_info})")


def main():
    parser = argparse.ArgumentParser(description="Project Memory CLI")
    subparsers = parser.add_subparsers(dest="command", help="Sub-commands")

    # list
    list_parser = subparsers.add_parser("list", help="List active projects sorted by score")
    list_parser.add_argument("--top", "-n", type=int, help="Limit output to top N projects")
    list_parser.add_argument("--json", action="store_true", help="Output in JSON format")

    # get
    get_parser = subparsers.add_parser("get", help="Get project details and roadmap tasks")
    get_parser.add_argument("project_path", help="Relative path or name of project note")
    get_parser.add_argument("--json", action="store_true", help="Output in JSON format")

    # feedback
    fb_parser = subparsers.add_parser("feedback", help="Log review feedback for a project")
    fb_parser.add_argument("project_path", help="Relative path or name of project note")
    fb_parser.add_argument("pos_action", nargs="?", help="Action: ok, less-often, more-often, finished, emergency")
    fb_parser.add_argument("--action", "-a", choices=["ok", "less-often", "more-often", "finished", "emergency"], help="Action to perform")
    fb_parser.add_argument("--worked", "-w", action="store_true", help="Set if user worked on the project")

    # complete-task
    comp_parser = subparsers.add_parser("complete-task", help="Check off a task in a project note")
    comp_parser.add_argument("project_path", help="Relative path or name of project note")
    comp_parser.add_argument("task_text", help="Text snippet of the task to mark completed")

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
    elif args.command == "complete-task":
        cmd_complete_task(args, data)
    elif args.command == "work":
        cmd_work(args, data)


if __name__ == "__main__":
    main()
