"""Scottie daily NHL meta research loop — cost-bounded, once/day."""

__version__ = "1.0.0"

# Hard limits (also enforced in Budget)
MAX_WEB_SEARCHES = 10
MAX_PAGES = 20
MAX_REDDIT = 5
MAX_CREATORS = 3
MAX_SYNTHESIS_CALLS = 1
MAX_PROPOSALS = 1
MAX_INTERNAL_REPORTS = 10
MAX_FEEDBACK_ITEMS = 10
MAX_TRANSIENT_RETRIES = 1

OUTCOMES = (
    "NO_MEANINGFUL_CHANGE",
    "KNOWLEDGE_UPDATED",
    "REVIEW_REQUIRED",
    "RESEARCH_INCOMPLETE",
    "SOURCE_CONFLICT",
)

CONFIDENCE = ("official", "high", "medium", "low", "unverified")
STATUSES = (
    "candidate",
    "corroborated",
    "approved",
    "disputed",
    "obsolete",
    "archived",
)

GAME_STATUSES = (
    "current",
    "announced",
    "early_access",
    "released_not_yet_supported",
    "supported",
    "legacy",
    "unknown",
)

# Production files that must NEVER be auto-modified by the loop
PROTECTED_PATHS = (
    "rubric/",
    "identity.md",
    "role.md",
    "analysis-guidelines.md",  # core boundaries; proposals only for material rewrites
)
PROTECTED_ACTIONS = (
    "scoring_rubric",
    "report_schema",
    "scoring_weights",
    "identity",
    "hard_boundaries",
    "production_prompt",
    "supported_game_list",
)
