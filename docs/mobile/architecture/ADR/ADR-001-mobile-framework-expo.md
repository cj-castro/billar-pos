# ADR-001: Mobile framework - Expo (React Native) + TypeScript

## Status
Accepted (D1)

## Problem
Android-first, iOS-ready staff app for a React/TS web POS, built on a Windows host with JDK 21 and no Android Studio, by a small team.

## Options
1. Expo / React Native (prebuild, local Gradle).
2. Bare React Native.
3. Flutter.
4. Kotlin Multiplatform + Compose Multiplatform.
5. Native Kotlin + Swift.
6. Capacitor / PWA wrapping the existing web app.

## Decision
Option 1: Expo SDK 58, React Native 0.88, TypeScript, Expo Router, TanStack Query 5, zustand, axios, socket.io-client 4.8, i18next 26.

## Rationale
Weighted score 87/100 vs Capacitor 80, bare RN 79, Flutter 65 (TECH_STACK_DECISION section 3). Highest reuse of web logic, one codebase, native config as code (config plugins), command-line Android builds, iOS via the same project later.

## Consequences
- Port, not share, web code (React 18 vs 19; no monorepo package).
- Native layer is generated; fix native issues through config plugins or `prebuild --clean`.
- Hermes `Intl` support must be verified for es-MX currency and plurals.
- iOS stays unverified until a Mac exists.
- Cleartext HTTP must be enabled explicitly on Android.

## Reversibility
Medium. Domain, API, repositories and tests are plain TS. Leaving Expo for bare RN is trivial; leaving RN means re-implementing UI only if the backend contract and tests are kept.
