"""Source adapters: fixture (tests/CI) and bounded live."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote_plus
from urllib.request import Request, urlopen

from .budget import Budget
from .models import scrub_untrusted_text


@dataclass
class SourceDoc:
    url: str
    title: str
    snippet: str
    source_type: str  # official | competitive | community | creator
    tier: int
    published: str = ""
    meta: dict[str, Any] = field(default_factory=dict)

    def safe_text(self) -> str:
        return scrub_untrusted_text(f"{self.title}\n{self.snippet}")


class SourceAdapter(Protocol):
    name: str

    def search(self, budget: Budget, topic_key: str, query: str) -> list[SourceDoc]: ...

    def open_page(self, budget: Budget, url: str) -> SourceDoc | None: ...

    def reddit_threads(self, budget: Budget, subreddit: str, limit: int = 5) -> list[SourceDoc]: ...

    def creator_items(self, budget: Budget, query: str, limit: int = 3) -> list[SourceDoc]: ...


class FixtureAdapter:
    """Deterministic adapter for tests and dry-run without network."""

    name = "fixture"

    def __init__(self, fixture: dict[str, Any] | None = None, path: Path | None = None) -> None:
        if path and path.is_file():
            self.data = json.loads(path.read_text(encoding="utf-8"))
        else:
            self.data = fixture or {}
        self.fail_urls = set(self.data.get("fail_urls") or [])
        self._search_map: dict[str, list[dict]] = self.data.get("searches") or {}
        self._pages: dict[str, dict] = self.data.get("pages") or {}
        self._reddit: list[dict] = self.data.get("reddit") or []
        self._creators: list[dict] = self.data.get("creators") or []

    def search(self, budget: Budget, topic_key: str, query: str) -> list[SourceDoc]:
        budget.record_search(topic_key)
        rows = self._search_map.get(topic_key) or self._search_map.get(query) or []
        out = []
        for r in rows:
            out.append(self._doc(r))
        return out

    def open_page(self, budget: Budget, url: str) -> SourceDoc | None:
        if url in self.fail_urls:
            if budget.can_retry():
                budget.record_retry()
            return None
        if url not in self._pages:
            # Unknown URL in fixture mode: do not invent content (still counts if we choose to hit)
            return None
        budget.record_page()
        return self._doc(self._pages[url])

    def reddit_threads(self, budget: Budget, subreddit: str, limit: int = 5) -> list[SourceDoc]:
        out = []
        for r in self._reddit:
            if not budget.can_reddit():
                break
            if r.get("subreddit") and r["subreddit"].lower() != subreddit.lower():
                continue
            budget.record_reddit()
            d = self._doc(r)
            d.meta["subreddit"] = r.get("subreddit") or subreddit
            out.append(d)
            if len(out) >= limit:
                break
        return out

    def creator_items(self, budget: Budget, query: str, limit: int = 3) -> list[SourceDoc]:
        out = []
        for r in self._creators:
            if not budget.can_creator():
                break
            budget.record_creator()
            out.append(self._doc(r))
            if len(out) >= limit:
                break
        return out

    def _doc(self, r: dict) -> SourceDoc:
        return SourceDoc(
            url=str(r.get("url") or ""),
            title=str(r.get("title") or ""),
            snippet=str(r.get("snippet") or r.get("text") or ""),
            source_type=str(r.get("source_type") or "community"),
            tier=int(r.get("tier") or 3),
            published=str(r.get("published") or ""),
            meta=dict(r.get("meta") or {}),
        )


class LiveAdapter:
    """Bounded live research via DuckDuckGo HTML + lightweight fetches.

    No paid APIs. Failures are soft. Respects budget hard stops.
    """

    name = "live"
    UA = "ScottieResearchBot/1.0 (+local; daily bounded NHL meta; contact: ops)"

    def __init__(self, timeout_s: float = 12.0) -> None:
        self.timeout_s = timeout_s

    def _get(self, url: str) -> str:
        req = Request(url, headers={"User-Agent": self.UA, "Accept": "text/html,application/xhtml+xml"})
        with urlopen(req, timeout=self.timeout_s) as resp:
            raw = resp.read(500_000)  # cap 500KB
        return raw.decode("utf-8", errors="replace")

    def search(self, budget: Budget, topic_key: str, query: str) -> list[SourceDoc]:
        budget.record_search(topic_key)
        # DuckDuckGo HTML (no API key)
        url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
        try:
            html = self._get(url)
        except (HTTPError, URLError, TimeoutError, OSError):
            if budget.can_retry():
                budget.record_retry()
                try:
                    html = self._get(url)
                except Exception:
                    return []
            else:
                return []
        docs: list[SourceDoc] = []
        # crude result parse
        for m in re.finditer(
            r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?class="result__snippet"[^>]*>(.*?)</(?:a|td|div)',
            html,
            re.I | re.S,
        ):
            href, title, snip = m.group(1), re.sub("<.*?>", "", m.group(2)), re.sub("<.*?>", "", m.group(3))
            st, tier = classify_url(href)
            docs.append(
                SourceDoc(
                    url=href[:500],
                    title=scrub_untrusted_text(title, 200),
                    snippet=scrub_untrusted_text(snip, 400),
                    source_type=st,
                    tier=tier,
                )
            )
            if len(docs) >= 8:
                break
        # fallback simpler regex
        if not docs:
            for m in re.finditer(r'uddg=([^&"]+)', html):
                from urllib.parse import unquote

                href = unquote(m.group(1))
                if not href.startswith("http"):
                    continue
                st, tier = classify_url(href)
                docs.append(SourceDoc(url=href[:500], title=href[:80], snippet="", source_type=st, tier=tier))
                if len(docs) >= 5:
                    break
        return docs

    def open_page(self, budget: Budget, url: str) -> SourceDoc | None:
        if not budget.can_page():
            return None
        if not url.startswith("https://") and not url.startswith("http://"):
            return None
        budget.record_page()
        try:
            html = self._get(url)
        except Exception:
            return None
        title_m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
        title = re.sub("<.*?>", "", title_m.group(1)).strip() if title_m else url
        text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", html)
        text = re.sub(r"(?is)<[^>]+>", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        st, tier = classify_url(url)
        return SourceDoc(
            url=url,
            title=scrub_untrusted_text(title, 200),
            snippet=scrub_untrusted_text(text, 1500),
            source_type=st,
            tier=tier,
        )

    def reddit_threads(self, budget: Budget, subreddit: str, limit: int = 5) -> list[SourceDoc]:
        # public JSON endpoint
        api = f"https://www.reddit.com/r/{subreddit}/hot.json?limit={min(limit, 5)}"
        out: list[SourceDoc] = []
        try:
            raw = self._get(api)
            data = json_loads_safe(raw)
            children = (((data or {}).get("data") or {}).get("children")) or []
        except Exception:
            return []
        for ch in children:
            if not budget.can_reddit():
                break
            d = (ch or {}).get("data") or {}
            title = d.get("title") or ""
            selftext = d.get("selftext") or ""
            permalink = d.get("permalink") or ""
            url = f"https://www.reddit.com{permalink}" if permalink else (d.get("url") or "")
            budget.record_reddit()
            out.append(
                SourceDoc(
                    url=url,
                    title=scrub_untrusted_text(str(title), 200),
                    snippet=scrub_untrusted_text(str(selftext), 500),
                    source_type="community",
                    tier=3,
                    published=str(d.get("created_utc") or ""),
                    meta={
                        "subreddit": subreddit,
                        "score": d.get("score"),
                        "num_comments": d.get("num_comments"),
                    },
                )
            )
            if len(out) >= limit:
                break
        return out

    def creator_items(self, budget: Budget, query: str, limit: int = 3) -> list[SourceDoc]:
        # Search only — no video download/transcript
        docs = self.search(budget, topic_key=f"creator:{query[:40]}", query=f"{query} site:youtube.com")
        out = []
        for d in docs:
            if not budget.can_creator():
                break
            if "youtube.com" not in d.url and "youtu.be" not in d.url:
                continue
            budget.record_creator()
            d.source_type = "creator"
            d.tier = 2
            out.append(d)
            if len(out) >= limit:
                break
        return out


def json_loads_safe(text: str) -> Any:
    import json

    # strip non-json prefix if any
    t = text.strip()
    if t.startswith("<!"):
        return None
    return json.loads(t)


def classify_url(url: str) -> tuple[str, int]:
    u = (url or "").lower()
    official_hosts = (
        "ea.com",
        "help.ea.com",
        "answers.ea.com",
        "easports.com",
        "ea.com/games/nhl",
        "store.steampowered.com/app",  # store listing can corroborate release
        "playstation.com",
        "xbox.com",
    )
    if any(h in u for h in official_hosts) or "ea sports nhl" in u and "ea.com" in u:
        return "official", 1
    if "reddit.com" in u:
        return "community", 3
    if "youtube.com" in u or "youtu.be" in u:
        return "creator", 2
    if any(x in u for x in ("hutdb", "eashl", "operation sports", "operationsports")):
        return "competitive", 2
    return "community", 3
