# Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository when available, or contact the
maintainer privately. Include the affected commit, the conditions needed to reproduce the issue
and its impact. Use synthetic records and omit credentials and personal data.

The Node development server binds to loopback and provides a health check and an optional
preview for public BLS and Open Food Facts catalog files and barcode lookup. The barcode
preview queries Open Food Facts online only when the developer enables live fallback.
