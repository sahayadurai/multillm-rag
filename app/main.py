"""FastAPI application — MultiLLM RAG Chatbot."""
from __future__ import annotations
import json, uuid, shutil, time
from datetime import datetime
from pathlib import Path
from typing import Optional
from collections import Counter

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, Depends
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session as DBSession

from app.config import (
    UPLOAD_DIR, INDEX_DIR, RESULTS_DIR, CHAT_DIR,
    AVAILABLE_MODELS, HOST, PORT, OPENROUTER_API_KEY,
)
from app.database import init_db, get_db, Session, UploadedFile as DBUploadedFile, ChatMessage, Rating
from app.file_processor import (
    extract_text_chunks, extract_images, extract_tables,
)
from app.embeddings import build_index, query_index
from app.llm_client import chat_completion

app = FastAPI(title="MultiLLM RAG Chatbot", version="2.0.0")

app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")
templates = Jinja2Templates(directory=Path(__file__).parent / "templates")

# ── Benchmark calculation helpers ────────────────────────────────────────────
def calculate_bleu(reference: str, candidate: str, n: int = 2) -> float:
    """Calculate simplified BLEU score (n-gram overlap)."""
    ref_tokens = reference.lower().split()
    cand_tokens = candidate.lower().split()
    if not cand_tokens or not ref_tokens:
        return 0.0
    overlap = sum((Counter(cand_tokens) & Counter(ref_tokens)).values())
    return min(overlap / len(cand_tokens), 1.0)

def calculate_rouge_l(reference: str, candidate: str) -> float:
    """Calculate ROUGE-L score (longest common subsequence)."""
    def lcs_length(s1: list, s2: list) -> int:
        m, n = len(s1), len(s2)
        dp = [[0] * (n + 1) for _ in range(m + 1)]
        for i in range(1, m + 1):
            for j in range(1, n + 1):
                if s1[i - 1] == s2[j - 1]:
                    dp[i][j] = dp[i - 1][j - 1] + 1
                else:
                    dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
        return dp[m][n]
    
    ref_tokens = reference.lower().split()
    cand_tokens = candidate.lower().split()
    if not cand_tokens or not ref_tokens:
        return 0.0
    lcs = lcs_length(ref_tokens, cand_tokens)
    return lcs / max(len(ref_tokens), len(cand_tokens))

def calculate_relative_scores(answers: list[str]) -> dict[str, list[float]]:
    """Calculate relative benchmark scores using mutual consensus (each vs all others)."""
    if not answers or len(answers) < 2:
        return {"bleu": [0.0] * len(answers), "rouge": [0.0] * len(answers)}
    
    n = len(answers)
    scores_bleu = []
    scores_rouge = []
    
    # For each answer, compare it against every OTHER answer and average the scores
    for i, candidate in enumerate(answers):
        bleu_vals = []
        rouge_vals = []
        for j, reference in enumerate(answers):
            if i == j:
                continue
            bleu_vals.append(calculate_bleu(reference, candidate))
            rouge_vals.append(calculate_rouge_l(reference, candidate))
        scores_bleu.append(sum(bleu_vals) / len(bleu_vals) if bleu_vals else 0.0)
        scores_rouge.append(sum(rouge_vals) / len(rouge_vals) if rouge_vals else 0.0)
    
    # Normalize so scores are on a 0-1 scale relative to the best performer
    max_bleu = max(scores_bleu) if scores_bleu else 1.0
    max_rouge = max(scores_rouge) if scores_rouge else 1.0
    
    scores_bleu = [round(s / max_bleu, 3) if max_bleu > 0 else 0.0 for s in scores_bleu]
    scores_rouge = [round(s / max_rouge, 3) if max_rouge > 0 else 0.0 for s in scores_rouge]
    
    return {"bleu": scores_bleu, "rouge": scores_rouge}

# Initialize database on startup
@app.on_event("startup")
async def startup_event():
    """Initialize database on application startup."""
    try:
        init_db()
    except Exception as e:
        print(f"Warning: Could not initialize database: {e}")


# ── Session Management ──────────────────────────────────────────────────────

def _get_or_create_session_db(session_id: Optional[str] = None, db: DBSession = None) -> tuple[str, Session]:
    """Get or create session in database."""
    if not db:
        db = next(get_db())
    
    if session_id:
        session = db.query(Session).filter(Session.id == session_id).first()
        if session:
            return session.id, session
    
    # Create new session
    sid = session_id or str(uuid.uuid4())[:8]
    new_session = Session(id=sid)
    db.add(new_session)
    db.commit()
    db.refresh(new_session)
    return sid, new_session


# ── Routes ──────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {
        "request": request,
        "models": AVAILABLE_MODELS,
    })


@app.get("/api/models")
async def list_models():
    return {"models": AVAILABLE_MODELS}


@app.get("/api/sessions")
async def list_sessions(db: DBSession = Depends(get_db)):
    """List all sessions."""
    sessions = db.query(Session).all()
    return {"sessions": [
        {
            "id": s.id,
            "files": len(s.files),
            "chats": len(s.chats),
            "created": s.created_at.isoformat() if s.created_at else None
        }
        for s in sessions
    ]}


@app.get("/api/session/{session_id}")
async def get_session(session_id: str, db: DBSession = Depends(get_db)):
    """Get session details including chat history."""
    session = db.query(Session).filter(Session.id == session_id).first()
    if not session:
        raise HTTPException(404, "Session not found")
    
    chats = []
    for chat in session.chats:
        chats.append({
            "id": chat.id,
            "query": chat.query,
            "timestamp": chat.timestamp.isoformat() if chat.timestamp else None,
            "models": chat.model_ids.split(",") if chat.model_ids else [],
            "results": chat.responses,
        })
    
    return {
        "id": session.id,
        "files": [f.to_dict() for f in session.files],
        "chats": chats,
        "chats_count": len(session.chats),
        "benchmarks_count": len(session.benchmarks),
        "created_at": session.created_at.isoformat() if session.created_at else None,
        "updated_at": session.updated_at.isoformat() if session.updated_at else None,
    }


@app.post("/api/upload")
async def upload_files(
    files: list[UploadFile] = File(...),
    text_chunk_size: int = Form(512),
    text_chunk_overlap: int = Form(64),
    image_chunk_size: int = Form(256),
    session_id: Optional[str] = Form(None),
    db: DBSession = Depends(get_db),
):
    """Upload files (PDF, DOCX, TXT, etc.), extract text, build FAISS indices."""
    sid, session = _get_or_create_session_db(session_id, db)

    results = []
    for upload in files:
        if not upload.filename:
            continue

        # Save file
        dest = UPLOAD_DIR / upload.filename
        with open(dest, "wb") as f:
            shutil.copyfileobj(upload.file, f)
        
        file_size = dest.stat().st_size

        # Extract text, images, tables
        text_chunks = extract_text_chunks(dest, text_chunk_size, text_chunk_overlap)
        image_chunks = extract_images(dest)
        table_chunks = extract_tables(dest)
        all_chunks = text_chunks + table_chunks + image_chunks

        # Build index
        idx_info = build_index(all_chunks, upload.filename)

        # Create database record
        file_record = DBUploadedFile(
            id=str(uuid.uuid4()),
            session_id=sid,
            filename=upload.filename,
            file_path=str(dest),
            file_size=file_size,
            text_chunks_count=len(text_chunks),
            image_chunks_count=len(image_chunks),
            table_chunks_count=len(table_chunks),
            ground_truth_count=0,  # No more ground truth extraction
            text_chunk_size=text_chunk_size,
            text_chunk_overlap=text_chunk_overlap,
            image_chunk_size=image_chunk_size,
            index_path=idx_info.get("index_path"),
            metadata_path=idx_info.get("metadata_path"),
            index_status="indexed" if idx_info.get("index_path") else "error",
        )
        db.add(file_record)
        db.commit()

        results.append({
            "filename": upload.filename,
            "text_chunks": len(text_chunks),
            "image_chunks": len(image_chunks),
            "table_chunks": len(table_chunks),
            "total_chunks": len(all_chunks),
            **idx_info,
        })

    return {"session_id": sid, "results": results}


@app.get("/download/{filename}")
async def download_file(filename: str):
    """Download uploaded file."""
    try:
        file_path = UPLOAD_DIR / filename
        if not file_path.exists():
            raise HTTPException(404, "File not found")
        return FileResponse(file_path, filename=filename)
    except Exception as e:
        raise HTTPException(400, f"Download failed: {str(e)}")


@app.post("/api/query")
async def query_rag(
    query: str = Form(...),
    session_id: str = Form(...),
    models: str = Form(...),          # comma-separated model IDs
    top_k: int = Form(5),
    cosine_threshold: float = Form(0.0),
    temperature: float = Form(0.3),
    db: DBSession = Depends(get_db),
):
    """Query the RAG pipeline with selected models."""
    if not OPENROUTER_API_KEY:
        raise HTTPException(
            400,
            "OPENROUTER_API_KEY is not set. Please set it in your .env file "
            "and restart the server."
        )
    
    # Get session from DB
    session = db.query(Session).filter(Session.id == session_id).first()
    if not session:
        raise HTTPException(404, "Session not found")
    if not session.files:
        raise HTTPException(400, "No files indexed in this session")

    model_ids = [m.strip() for m in models.split(",") if m.strip()]

    # Retrieve from all indexed files
    all_retrieved: list[dict] = []
    for file_record in session.files:
        try:
            chunks = query_index(query, file_record.filename, top_k, cosine_threshold)
            all_retrieved.extend(chunks)
        except FileNotFoundError:
            continue

    # Sort by score globally and take top_k
    all_retrieved.sort(key=lambda x: x.get("score", 0), reverse=True)
    top_chunks = all_retrieved[:top_k]

    # Build context
    context_parts = []
    for i, chunk in enumerate(top_chunks, 1):
        context_parts.append(
            f"[Source: {chunk['source']}, Page {chunk['page']}, "
            f"Score: {chunk['score']:.3f}]\n{chunk['text']}"
        )
    context_str = "\n\n---\n\n".join(context_parts)

    system_prompt = (
        "You are a helpful assistant. Answer the question "
        "based on the provided context. Be concise and accurate.\n\n"
        f"Context:\n{context_str}"
    )

    # Query each model simultaneously
    model_results = []
    for model_id in model_ids:
        try:
            llm_resp = await chat_completion(
                model=model_id,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": query},
                ],
                temperature=temperature,
            )

            result_entry = {
                "model": model_id,
                "answer": llm_resp["content"],
                "latency_s": llm_resp["latency_s"],
                "usage": llm_resp["usage"],
                "sources": [
                    {"source": c["source"], "page": c["page"],
                     "score": c["score"], "type": c.get("type", "text")}
                    for c in top_chunks
                ],
                "context_used": context_str,
            }

            model_results.append(result_entry)
        except Exception as e:
            model_results.append({
                "model": model_id,
                "error": str(e),
            })

    # Calculate benchmark scores (comparing all answers)
    successful_answers = [r["answer"] for r in model_results if "answer" in r]
    if len(successful_answers) >= 2:
        benchmark_scores = calculate_relative_scores(successful_answers)
        score_idx = 0
        for result in model_results:
            if "answer" in result:
                result["benchmark"] = {
                    "bleu": round(benchmark_scores["bleu"][score_idx], 3),
                    "rouge": round(benchmark_scores["rouge"][score_idx], 3),
                    "faithfulness": 0.0,  # Placeholder
                    "answer_relevancy": 0.0,  # Placeholder
                    "context_precision": 0.0,  # Placeholder
                    "context_recall": 0.0,  # Placeholder
                }
                score_idx += 1

    # Save to chat history in DB
    chat_entry = ChatMessage(
        id=str(uuid.uuid4())[:8],
        session_id=session_id,
        query=query,
        top_k=top_k,
        temperature=int(temperature * 10),  # Store as int*10
        cosine_threshold=int(cosine_threshold * 100),  # Store as int*100
        model_ids=",".join(model_ids),
        responses=model_results,
        run_benchmark=False,
    )
    db.add(chat_entry)
    db.commit()

    return {"session_id": session_id, "chat": {
        "id": chat_entry.id,
        "query": chat_entry.query,
        "timestamp": chat_entry.timestamp.isoformat() if chat_entry.timestamp else None,
        "models": model_ids,
        "top_k": top_k,
        "temperature": temperature,
        "results": model_results,
    }}



@app.post("/api/rate")
async def rate_response(
    chat_id: str = Form(...),
    model_id: str = Form(...),
    score: int = Form(None),
    rating_type: str = Form("score"),  # "thumbs_up", "thumbs_down", "score", "custom"
    notes: str = Form(None),
    db: DBSession = Depends(get_db),
):
    """Save human rating for a model response."""
    try:
        chat = db.query(ChatMessage).filter(ChatMessage.id == chat_id).first()
        if not chat:
            raise HTTPException(404, "Chat not found")

        rating = Rating(
            id=str(uuid.uuid4()),
            chat_message_id=chat_id,
            model_id=model_id,
            score=score,
            rating_type=rating_type,
            notes=notes,
        )
        db.add(rating)
        db.commit()

        return {
            "id": rating.id,
            "model_id": rating.model_id,
            "score": rating.score,
            "rating_type": rating.rating_type,
            "notes": rating.notes,
            "timestamp": rating.timestamp.isoformat() if rating.timestamp else None,
        }
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/ratings/{chat_id}")
async def get_ratings(chat_id: str, db: DBSession = Depends(get_db)):
    """Get all ratings for a chat."""
    chat = db.query(ChatMessage).filter(ChatMessage.id == chat_id).first()
    if not chat:
        raise HTTPException(404, "Chat not found")
    
    return {
        "chat_id": chat_id,
        "ratings": [r.to_dict() for r in chat.ratings]
    }


@app.delete("/api/chat/{chat_id}")
async def delete_chat(chat_id: str, db: DBSession = Depends(get_db)):
    """Delete a specific chat message."""
    chat = db.query(ChatMessage).filter(ChatMessage.id == chat_id).first()
    if not chat:
        raise HTTPException(404, "Chat not found")
    
    db.delete(chat)
    db.commit()
    return {"status": "deleted"}


@app.post("/api/session/{session_id}/delete_all_chats")
async def delete_all_chats(session_id: str, db: DBSession = Depends(get_db)):
    """Delete all chats in a session."""
    session = db.query(Session).filter(Session.id == session_id).first()
    if not session:
        raise HTTPException(404, "Session not found")
    
    # Delete all chats in this session (cascade delete will handle ratings)
    db.query(ChatMessage).filter(ChatMessage.session_id == session_id).delete()
    db.commit()
    return {"status": "all chats deleted"}


@app.get("/api/chat_history/{session_id}")
async def chat_history(session_id: str, db: DBSession = Depends(get_db)):
    """Get chat history for a session."""
    session = db.query(Session).filter(Session.id == session_id).first()
    if not session:
        raise HTTPException(404, "Session not found")
    return {"chats": [chat.to_dict() for chat in session.chats]}


# ── Helpers ─────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=True)
