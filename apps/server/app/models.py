from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Speaker = Literal["interviewer", "candidate"]
ConnectionRole = Literal["interviewer", "candidate", "client", "model"]


class BrowserLogin(BaseModel):
    access_token: str = Field(min_length=1, max_length=4096)


class CaptureDevice(BaseModel):
    device_name: str = Field(default="我的电脑", min_length=1, max_length=80)


class ConversationSwitch(BaseModel):
    current_id: str = Field(min_length=1, max_length=64)
    target_id: str | None = Field(default=None, min_length=1, max_length=64)
    stop_active: bool = False


class ConversationRename(BaseModel):
    title: str = Field(min_length=1, max_length=120)
