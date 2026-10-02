from pathlib import Path

PROMPTS = Path(__file__).resolve().parents[1] / "prompts"
PROFILES = {"default": "通用", "brief": "临场短答", "lc": "算法 / LC", "ood": "对象设计 / OOD"}


def instructions(profile: str) -> str:
    if profile not in PROFILES:
        raise ValueError("无效的回答提示词。")
    text = (PROMPTS / "default.md").read_text(encoding="utf-8")
    return text + "\n\n" + preference(profile)


def preference(profile: str) -> str:
    if profile not in PROFILES:
        raise ValueError("无效的回答提示词。")
    text = (PROMPTS / 'lc.md').read_text(encoding='utf-8')
    if profile in {'brief', 'ood'}:
        text += '\n\n' + (PROMPTS / f'{profile}.md').read_text(encoding='utf-8')
    return text
