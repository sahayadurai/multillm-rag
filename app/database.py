"""Database setup and models."""
from __future__ import annotations
import json
from datetime import datetime
from typing import Optional

from sqlalchemy import create_engine, Column, String, Integer, DateTime, Text, Boolean, ForeignKey, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship

from app.config import DATABASE_URL

# Database engine and session
engine = create_engine(DATABASE_URL, echo=False)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Session(Base):
    """Represents a user session."""
    __tablename__ = "sessions"

    id = Column(String, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    files = relationship("UploadedFile", back_populates="session", cascade="all, delete-orphan")
    chats = relationship("ChatMessage", back_populates="session", cascade="all, delete-orphan")
    benchmarks = relationship("Benchmark", back_populates="session", cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "file_count": len(self.files),
            "chat_count": len(self.chats),
            "benchmark_count": len(self.benchmarks),
        }


class UploadedFile(Base):
    """Represents an uploaded PDF file."""
    __tablename__ = "uploaded_files"

    id = Column(String, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("sessions.id"), index=True)
    filename = Column(String, index=True)
    file_path = Column(String)
    file_size = Column(Integer)
    upload_date = Column(DateTime, default=datetime.utcnow, index=True)

    # Extraction metadata
    text_chunks_count = Column(Integer, default=0)
    image_chunks_count = Column(Integer, default=0)
    table_chunks_count = Column(Integer, default=0)
    ground_truth_count = Column(Integer, default=0)

    # Index metadata
    index_path = Column(String, nullable=True)
    metadata_path = Column(String, nullable=True)
    index_status = Column(String, default="pending")  # pending, indexed, error

    # Extraction parameters
    text_chunk_size = Column(Integer, default=512)
    text_chunk_overlap = Column(Integer, default=64)
    image_chunk_size = Column(Integer, default=256)

    # Relationship
    session = relationship("Session", back_populates="files")
    ground_truths = relationship("GroundTruth", back_populates="file", cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id,
            "filename": self.filename,
            "file_size": self.file_size,
            "upload_date": self.upload_date.isoformat() if self.upload_date else None,
            "text_chunks_count": self.text_chunks_count,
            "image_chunks_count": self.image_chunks_count,
            "table_chunks_count": self.table_chunks_count,
            "ground_truth_count": self.ground_truth_count,
            "index_status": self.index_status,
        }


class GroundTruth(Base):
    """Represents ground truth Q&A pairs extracted from PDFs."""
    __tablename__ = "ground_truths"

    id = Column(String, primary_key=True, index=True)
    file_id = Column(String, ForeignKey("uploaded_files.id"), index=True)
    question = Column(Text)
    answer = Column(Text)
    extraction_method = Column(String)  # "qa_pattern" or "section_heading"
    created_at = Column(DateTime, default=datetime.utcnow)

    file = relationship("UploadedFile", back_populates="ground_truths")

    def to_dict(self):
        return {
            "id": self.id,
            "question": self.question,
            "answer": self.answer,
            "extraction_method": self.extraction_method,
        }


class ChatMessage(Base):
    """Represents a chat message (query + responses)."""
    __tablename__ = "chat_messages"

    id = Column(String, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("sessions.id"), index=True)
    query = Column(Text)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)

    # Query parameters
    top_k = Column(Integer, default=5)
    temperature = Column(Integer, default=3)  # stored as int*10 (e.g., 0.3 -> 3)
    cosine_threshold = Column(Integer, default=0)  # stored as int*100

    # Models queried (comma-separated)
    model_ids = Column(String)

    # Responses (stored as JSON for flexibility)
    responses = Column(JSON, default=list)

    # Benchmark run
    run_benchmark = Column(Boolean, default=False)

    # Relationship
    session = relationship("Session", back_populates="chats")
    ratings = relationship("Rating", back_populates="chat_message", cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id,
            "query": self.query,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "top_k": self.top_k,
            "temperature": self.temperature / 10.0,
            "model_ids": self.model_ids.split(",") if self.model_ids else [],
            "responses": self.responses,
            "run_benchmark": self.run_benchmark,
        }


class Benchmark(Base):
    """Represents benchmark evaluation results."""
    __tablename__ = "benchmarks"

    id = Column(String, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("sessions.id"), index=True)
    chat_message_id = Column(String, nullable=True)  # Associated chat
    model_id = Column(String, index=True)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)

    # Benchmark parameters
    max_questions = Column(Integer, default=10)
    top_k = Column(Integer, default=5)

    # Results (stored as JSON)
    aggregate_metrics = Column(JSON, default=dict)
    detailed_results = Column(JSON, default=list)

    # Relationship
    session = relationship("Session", back_populates="benchmarks")

    def to_dict(self):
        return {
            "id": self.id,
            "model_id": self.model_id,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "aggregate_metrics": self.aggregate_metrics,
            "detailed_results": self.detailed_results,
        }


class Rating(Base):
    """Represents human feedback rating for model answers."""
    __tablename__ = "ratings"

    id = Column(String, primary_key=True, index=True)
    chat_message_id = Column(String, ForeignKey("chat_messages.id"), index=True)
    model_id = Column(String, index=True)
    score = Column(Integer, nullable=True)  # 1-10 score
    rating_type = Column(String, default="score")  # "thumbs_up", "thumbs_down", "score", "custom"
    notes = Column(Text, nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)

    chat_message = relationship("ChatMessage", back_populates="ratings")

    def to_dict(self):
        return {
            "id": self.id,
            "model_id": self.model_id,
            "score": self.score,
            "rating_type": self.rating_type,
            "notes": self.notes,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
        }


def init_db():
    """Initialize database tables."""
    Base.metadata.create_all(bind=engine)


def get_db():
    """Get database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
