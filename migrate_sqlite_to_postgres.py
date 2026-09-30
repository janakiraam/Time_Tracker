"""
Migration Script: SQLite (Time Tracker) → PostgreSQL
====================================================
This script reads a timetracker.sqlite file and inserts all data into PostgreSQL.

Usage:
    python migrate_sqlite_to_postgres.py                          # Uses latest .sqlite in Downloads
    python migrate_sqlite_to_postgres.py path/to/file.sqlite      # Uses specific file

PostgreSQL Target:
    - Host: localhost
    - Port: 5432
    - Database: time_tracker
    - User: postgres
    - Password: root

Tables Created:
    - tt_tasks (from SQLite 'tasks' table)
    - tt_planner (from SQLite 'planner' table)
"""

import sqlite3
import psycopg2
import psycopg2.extras
import os
import sys
import glob
from datetime import datetime

# ==========================================
# Configuration
# ==========================================

PG_CONFIG = {
    'host': 'localhost',
    'port': '5432',
    'database': 'time_tracker',
    'user': 'postgres',
    'password': 'root'
}

# Default SQLite file location - finds the latest TimeTracker_*.sqlite in Downloads
DOWNLOADS_DIR = os.path.expanduser(r'~\Downloads')


def find_latest_sqlite():
    """Find the latest TimeTracker sqlite file in Downloads"""
    pattern = os.path.join(DOWNLOADS_DIR, 'TimeTracker_*.sqlite')
    files = glob.glob(pattern)
    if not files:
        # Also check for timetracker.sqlite
        fallback = os.path.join(DOWNLOADS_DIR, 'timetracker.sqlite')
        if os.path.exists(fallback) and os.path.getsize(fallback) > 0:
            return fallback
        return None
    # Sort by modification time, get latest
    files.sort(key=os.path.getmtime, reverse=True)
    return files[0]


def create_pg_database():
    """Create PostgreSQL database if it doesn't exist"""
    try:
        conn = psycopg2.connect(
            host=PG_CONFIG['host'],
            port=PG_CONFIG['port'],
            database='postgres',
            user=PG_CONFIG['user'],
            password=PG_CONFIG['password']
        )
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM pg_catalog.pg_database WHERE datname = %s", (PG_CONFIG['database'],))
        if not cur.fetchone():
            cur.execute(f"CREATE DATABASE {PG_CONFIG['database']}")
            print(f"  Created database '{PG_CONFIG['database']}'")
        else:
            print(f"  Database '{PG_CONFIG['database']}' already exists")
        cur.close()
        conn.close()
    except Exception as e:
        print(f"  Error creating database: {e}")
        raise


def create_tables(pg_conn):
    """Create tables in PostgreSQL"""
    cur = pg_conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS tt_tasks (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            name TEXT NOT NULL,
            category TEXT DEFAULT 'Other',
            startDate TEXT,
            startTime TEXT,
            endDate TEXT,
            endTime TEXT,
            notes TEXT,
            status TEXT DEFAULT 'running',
            duration REAL,
            createdAt TEXT
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS tt_planner (
            id SERIAL PRIMARY KEY,
            task_id TEXT NOT NULL,
            plan_date TEXT NOT NULL,
            name TEXT NOT NULL,
            category TEXT DEFAULT 'Other',
            status TEXT DEFAULT 'pending',
            startTime TEXT,
            endTime TEXT,
            duration REAL,
            notes TEXT,
            createdAt TEXT
        )
    """)

    pg_conn.commit()
    print("  Tables created/verified: tt_tasks, tt_planner")


def migrate_data(sqlite_path, pg_conn):
    """Migrate data from SQLite to PostgreSQL"""
    # Connect to SQLite
    sqlite_conn = sqlite3.connect(sqlite_path)
    sqlite_conn.row_factory = sqlite3.Row
    sqlite_cur = sqlite_conn.cursor()

    pg_cur = pg_conn.cursor()

    # Clear existing data in PostgreSQL
    pg_cur.execute('DELETE FROM tt_planner')
    pg_cur.execute('DELETE FROM tt_tasks')
    print("  Cleared existing PostgreSQL data")

    # Migrate tasks
    sqlite_cur.execute('SELECT * FROM tasks')
    tasks = sqlite_cur.fetchall()
    task_count = 0
    for task in tasks:
        pg_cur.execute("""
            INSERT INTO tt_tasks (id, task_id, name, category, startDate, startTime, endDate, endTime, notes, status, duration, createdAt)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
                task_id = EXCLUDED.task_id,
                name = EXCLUDED.name,
                category = EXCLUDED.category,
                startDate = EXCLUDED.startDate,
                startTime = EXCLUDED.startTime,
                endDate = EXCLUDED.endDate,
                endTime = EXCLUDED.endTime,
                notes = EXCLUDED.notes,
                status = EXCLUDED.status,
                duration = EXCLUDED.duration,
                createdAt = EXCLUDED.createdAt
        """, (
            task['id'], task['task_id'], task['name'], task['category'],
            task['startDate'], task['startTime'], task['endDate'], task['endTime'],
            task['notes'], task['status'], task['duration'], task['createdAt']
        ))
        task_count += 1

    # Migrate planner
    sqlite_cur.execute('SELECT * FROM planner')
    planners = sqlite_cur.fetchall()
    planner_count = 0

    # Reset sequence for planner
    pg_cur.execute("ALTER SEQUENCE tt_planner_id_seq RESTART WITH 1")

    for plan in planners:
        pg_cur.execute("""
            INSERT INTO tt_planner (task_id, plan_date, name, category, status, startTime, endTime, duration, notes, createdAt)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            plan['task_id'], plan['plan_date'], plan['name'], plan['category'],
            plan['status'], plan['startTime'], plan['endTime'],
            plan['duration'], plan['notes'], plan['createdAt']
        ))
        planner_count += 1

    pg_conn.commit()
    sqlite_conn.close()

    print(f"  Migrated: {task_count} tasks, {planner_count} planner entries")
    return task_count, planner_count


def main():
    print("\n" + "=" * 55)
    print("  Time Tracker: SQLite -> PostgreSQL Migration")
    print("=" * 55)

    # Determine SQLite file
    if len(sys.argv) > 1:
        sqlite_path = sys.argv[1]
    else:
        sqlite_path = find_latest_sqlite()

    if not sqlite_path or not os.path.exists(sqlite_path):
        print(f"\n  ERROR: SQLite file not found!")
        print(f"  Usage: python migrate_sqlite_to_postgres.py <path_to_sqlite_file>")
        print(f"  Or place TimeTracker_*.sqlite files in: {DOWNLOADS_DIR}")
        sys.exit(1)

    file_size = os.path.getsize(sqlite_path)
    if file_size == 0:
        print(f"\n  ERROR: SQLite file is empty (0 bytes): {sqlite_path}")
        print(f"  Please download the database from the Time Tracker app first.")
        sys.exit(1)

    print(f"\n  Source: {sqlite_path} ({file_size / 1024:.1f} KB)")
    print(f"  Target: PostgreSQL -> {PG_CONFIG['database']} @ {PG_CONFIG['host']}:{PG_CONFIG['port']}")
    print()

    # Step 1: Create database
    print("[1/3] Setting up PostgreSQL database...")
    create_pg_database()

    # Step 2: Connect and create tables
    print("[2/3] Creating tables...")
    pg_conn = psycopg2.connect(**PG_CONFIG)
    pg_conn.autocommit = False
    create_tables(pg_conn)

    # Step 3: Migrate data
    print("[3/3] Migrating data...")
    task_count, planner_count = migrate_data(sqlite_path, pg_conn)

    pg_conn.close()

    print("\n" + "=" * 55)
    print("  Migration Complete!")
    print(f"  Database: {PG_CONFIG['database']}")
    print(f"  Tasks migrated: {task_count}")
    print(f"  Planner entries migrated: {planner_count}")
    print("=" * 55)
    print("\n  To verify in pgAdmin or psql:")
    print(f"    SELECT * FROM tt_tasks;")
    print(f"    SELECT * FROM tt_planner;")
    print()


if __name__ == '__main__':
    main()