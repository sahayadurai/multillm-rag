#!/bin/bash

# ============================================================================
# RAG Benchmark PDF Data Extractor - Complete Setup & Run Script
# ============================================================================
# This script handles complete setup and deployment of the RAG system.
# It installs dependencies, configures the database, and launches the server.
# ============================================================================

set -e  # Exit on error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

print_success() {
    echo -e "${GREEN}[OK] $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}[WARN] $1${NC}"
}

print_error() {
    echo -e "${RED}[ERROR] $1${NC}"
}

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

print_header "RAG Benchmark System Setup & Launch"

# Step 1: Check Python installation
print_header "Step 1: Checking Python Installation"
if ! command -v python3 &> /dev/null; then
    print_error "Python 3 is not installed. Please install Python 3.9 or higher."
    exit 1
fi
PYTHON_VERSION=$(python3 --version)
print_success "Found: $PYTHON_VERSION"

# Step 2: Check or create virtual environment
print_header "Step 2: Setting Up Python Virtual Environment"
if [ ! -d "venv" ]; then
    print_warning "Virtual environment not found. Creating..."
    python3 -m venv venv
    print_success "Virtual environment created"
else
    print_success "Virtual environment already exists"
fi

# Activate virtual environment
source venv/bin/activate
print_success "Virtual environment activated"

# Step 3: Upgrade pip
print_header "Step 3: Upgrading pip, setuptools, and wheel"
pip install --upgrade pip setuptools wheel > /dev/null 2>&1
print_success "pip, setuptools, and wheel upgraded"

# Step 4: Install Python dependencies
print_header "Step 4: Installing Python Dependencies"
if [ -f "app/requirements.txt" ]; then
    pip install -r app/requirements.txt
    print_success "All dependencies installed"
else
    print_error "requirements.txt not found in app/"
    exit 1
fi

# Step 5: Create necessary directories
print_header "Step 5: Creating Data Directories"
mkdir -p data/uploads data/indices data/results data/chats
print_success "Data directories created"

# Step 6: Check for .env file
print_header "Step 6: Checking Environment Configuration"
if [ ! -f ".env" ]; then
    print_warning ".env file not found. Creating default..."
    cat > .env << EOF
# OpenRouter API Configuration
OPENROUTER_API_KEY=your_api_key_here
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# Embedding Model
EMBEDDING_MODEL=all-MiniLM-L6-v2

# Server Configuration
HOST=0.0.0.0
PORT=8000

# Database Configuration
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rag_benchmark
EOF
    print_success ".env file created with defaults"
    print_warning "IMPORTANT: Update OPENROUTER_API_KEY in .env with your actual API key"
else
    print_success ".env file found"
fi

# Step 7: Check PostgreSQL installation
print_header "Step 7: Checking PostgreSQL Installation"
if command -v psql &> /dev/null; then
    print_success "PostgreSQL client found"
    
    # Try to check if PostgreSQL server is running
    if pg_isready -h localhost > /dev/null 2>&1; then
        print_success "PostgreSQL server is running"
        
        # Check if database exists
        if psql -U postgres -lqt -h localhost 2>/dev/null | cut -d \| -f 1 | grep -qw rag_benchmark; then
            print_success "Database 'rag_benchmark' already exists"
        else
            print_warning "Database 'rag_benchmark' does not exist. Creating..."
            psql -U postgres -h localhost -c "CREATE DATABASE rag_benchmark;" 2>/dev/null || print_warning "Could not create database (may need sudo)"
            print_success "Database creation attempted"
        fi
    else
        print_warning "PostgreSQL server is not running. Starting..."
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            brew services start postgresql 2>/dev/null || print_warning "Could not start PostgreSQL via brew"
        elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
            # Linux
            sudo systemctl start postgresql 2>/dev/null || print_warning "Could not start PostgreSQL via systemctl"
        fi
        sleep 2
        
        # Try creating database again
        if pg_isready -h localhost > /dev/null 2>&1; then
            psql -U postgres -h localhost -c "CREATE DATABASE rag_benchmark;" 2>/dev/null || print_warning "Database may already exist"
            print_success "PostgreSQL connection established"
        else
            print_warning "PostgreSQL server still not accessible"
        fi
    fi
else
    print_warning "PostgreSQL client not found. You may need to install PostgreSQL manually."
    print_warning "macOS: brew install postgresql"
    print_warning "Linux: sudo apt-get install postgresql postgresql-contrib"
fi

# Step 8: Create data directories structure
print_header "Step 8: Verifying Application Structure"
REQUIRED_DIRS=(
    "app/templates"
    "app/static"
    "app/static/css"
    "app/static/js"
    "data/uploads"
    "data/indices"
    "data/results"
    "data/chats"
)

for dir in "${REQUIRED_DIRS[@]}"; do
    if [ -d "$dir" ]; then
        print_success "[OK] $dir"
    else
        print_warning "- $dir"
    fi
done

# Step 9: Display launch information
print_header "Configuration Summary"
echo -e "${BLUE}Python Version:${NC} $(python3 --version)"
echo -e "${BLUE}Virtual Env:${NC} $VIRTUAL_ENV"
echo -e "${BLUE}Working Directory:${NC} $SCRIPT_DIR"
echo -e "${BLUE}Database URL:${NC} $(grep DATABASE_URL .env | cut -d'=' -f2)"
echo -e "${BLUE}Server Host:${NC} $(grep '^HOST=' .env | cut -d'=' -f2)"
echo -e "${BLUE}Server Port:${NC} $(grep '^PORT=' .env | cut -d'=' -f2)"

# Step 10: Launch the application
print_header "Launching RAG Benchmark Server"
echo -e "${YELLOW}Starting server on $(grep '^HOST=' .env | cut -d'=' -f2):$(grep '^PORT=' .env | cut -d'=' -f2)${NC}"
echo -e "${YELLOW}Open http://localhost:8000 in your browser${NC}"
echo -e "${YELLOW}Press Ctrl+C to stop the server${NC}"
echo ""

# Launch the FastAPI application
CMD="python -m uvicorn app.main:app --host $(grep '^HOST=' .env | cut -d'=' -f2) --port $(grep '^PORT=' .env | cut -d'=' -f2) --reload"
echo "Executing: $CMD"

python -m uvicorn app.main:app --host $(grep '^HOST=' .env | cut -d'=' -f2) --port $(grep '^PORT=' .env | cut -d'=' -f2) --reload