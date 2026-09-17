"""Budget counters — hard stop when exhausted."""
from __future__ import annotations

from dataclasses import dataclass, field

from . import (
    MAX_CREATORS,
    MAX_PAGES,
    MAX_PROPOSALS,
    MAX_SYNTHESIS_CALLS,
    MAX_TRANSIENT_RETRIES,
    MAX_WEB_SEARCHES,
    MAX_REDDIT,
)


@dataclass
class Budget:
    web_searches: int = 0
    pages: int = 0
    reddit: int = 0
    creators: int = 0
    synthesis_calls: int = 0
    proposals: int = 0
    retries: int = 0
    topics_searched: set[str] = field(default_factory=set)

    max_web_searches: int = MAX_WEB_SEARCHES
    max_pages: int = MAX_PAGES
    max_reddit: int = MAX_REDDIT
    max_creators: int = MAX_CREATORS
    max_synthesis_calls: int = MAX_SYNTHESIS_CALLS
    max_proposals: int = MAX_PROPOSALS
    max_retries: int = MAX_TRANSIENT_RETRIES

    def can_search(self, topic_key: str) -> bool:
        if topic_key in self.topics_searched:
            return False
        return self.web_searches < self.max_web_searches

    def record_search(self, topic_key: str) -> None:
        if topic_key in self.topics_searched:
            raise RuntimeError(f"duplicate_search_topic:{topic_key}")
        if self.web_searches >= self.max_web_searches:
            raise RuntimeError("budget_web_searches_exhausted")
        self.topics_searched.add(topic_key)
        self.web_searches += 1

    def can_page(self) -> bool:
        return self.pages < self.max_pages

    def record_page(self) -> None:
        if self.pages >= self.max_pages:
            raise RuntimeError("budget_pages_exhausted")
        self.pages += 1

    def can_reddit(self) -> bool:
        return self.reddit < self.max_reddit

    def record_reddit(self) -> None:
        if self.reddit >= self.max_reddit:
            raise RuntimeError("budget_reddit_exhausted")
        self.reddit += 1

    def can_creator(self) -> bool:
        return self.creators < self.max_creators

    def record_creator(self) -> None:
        if self.creators >= self.max_creators:
            raise RuntimeError("budget_creators_exhausted")
        self.creators += 1

    def can_synthesis(self) -> bool:
        return self.synthesis_calls < self.max_synthesis_calls

    def record_synthesis(self) -> None:
        if self.synthesis_calls >= self.max_synthesis_calls:
            raise RuntimeError("budget_synthesis_exhausted")
        self.synthesis_calls += 1

    def can_proposal(self) -> bool:
        return self.proposals < self.max_proposals

    def record_proposal(self) -> None:
        if self.proposals >= self.max_proposals:
            raise RuntimeError("budget_proposals_exhausted")
        self.proposals += 1

    def can_retry(self) -> bool:
        return self.retries < self.max_retries

    def record_retry(self) -> None:
        if self.retries >= self.max_retries:
            raise RuntimeError("budget_retries_exhausted")
        self.retries += 1

    def snapshot(self) -> dict:
        return {
            "web_searches": self.web_searches,
            "pages": self.pages,
            "reddit": self.reddit,
            "creators": self.creators,
            "synthesis_calls": self.synthesis_calls,
            "proposals": self.proposals,
            "retries": self.retries,
            "topics": sorted(self.topics_searched),
            "limits": {
                "web_searches": self.max_web_searches,
                "pages": self.max_pages,
                "reddit": self.max_reddit,
                "creators": self.max_creators,
                "synthesis_calls": self.max_synthesis_calls,
                "proposals": self.max_proposals,
            },
        }
