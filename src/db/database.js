import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8 } from './migrations.js';

function migrate(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version > 8) {
    throw new Error(`database schema version ${version} is newer than this application`);
  }
  if (version === 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATION_1);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const { user_version: migratedVersion } = db.prepare('PRAGMA user_version').get();
  if (migratedVersion === 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATION_2);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const { user_version: secondMigratedVersion } = db.prepare('PRAGMA user_version').get();
  if (secondMigratedVersion === 2) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATION_3);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const { user_version: thirdMigratedVersion } = db.prepare('PRAGMA user_version').get();
  if (thirdMigratedVersion === 3) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATION_4);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const { user_version: fourthMigratedVersion } = db.prepare('PRAGMA user_version').get();
  if (fourthMigratedVersion === 4) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATION_5);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const { user_version: fifthMigratedVersion } = db.prepare('PRAGMA user_version').get();
  if (fifthMigratedVersion === 5) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATION_6);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const sixthMigratedVersion = db.prepare('PRAGMA user_version').get();
  if (sixthMigratedVersion.user_version === 6) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATION_7);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const seventhMigratedVersion = db.prepare('PRAGMA user_version').get();
  if (seventhMigratedVersion.user_version === 7) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATION_8);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function openDatabase(filename) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA busy_timeout = 5000');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
