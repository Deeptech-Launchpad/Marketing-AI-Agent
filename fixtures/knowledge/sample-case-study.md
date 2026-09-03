> **⚠️ TEST DATA — SYNTHETIC. NOT A REAL CASE STUDY.**
> Both "Meridian Catalog Services" and the customer "Halloway Industrial Supply"
> are fictional entities invented solely to exercise the RAG ingestion and
> retrieval pipeline in development. No engagement, figure, quotation or outcome
> below occurred. Do not use, quote, or publish any statement from this file.

# Case Study (SYNTHETIC) — Halloway Industrial Supply

**Permission status in this invented scenario:** named use approved in writing,
figures approved for publication. (This line exists so the content validator has
something to check the brand guidelines' substantiation rule against.)

## The customer

Halloway Industrial Supply is an invented distributor of pipe, valve and fitting
products serving contractors and facilities teams. In this scenario it carries
approximately 22,000 SKUs from 140 manufacturers on Magento, and sells almost
entirely to trade accounts.

## The situation

Halloway had grown by acquiring two smaller distributors. Each brought its own
product data conventions. After consolidation onto a single storefront:

- Roughly 60% of SKUs had no dimensional data at all.
- Thread standards were recorded inconsistently — some as text in the product
  title, some as an attribute, most not at all.
- The same fitting could appear under three category names inherited from three
  different source systems.
- Site search returned nothing useful for the way contractors actually search,
  which is by size and standard rather than by product name.

The commercial symptom: the inside sales desk was handling a large volume of
calls that were purely specification lookups, and the ecommerce manager could not
build usable filters because the underlying attributes did not exist.

## What Meridian did

1. Audited a 500-SKU sample across the three inherited catalogs to establish
   which attributes were missing and which source documents existed.
2. Defined a single attribute schema for pipe, valve and fitting products,
   including thread standard, pressure rating, material, connection type and
   nominal size.
3. Sourced attribute values from manufacturer datasheets, recording a provenance
   reference for every value written.
4. Enriched in batches of roughly 2,000 SKUs, publishing each batch to the live
   storefront before starting the next.
5. Rebuilt the category taxonomy and attached datasheets and installation
   documents to the enriched records.

The programme in this invented scenario ran seven months.

## Outcome (invented, approved for publication in this scenario)

- Attribute coverage across the enriched catalog rose from about 40% to about
  95% of the defined schema.
- Filterable attributes went from two to eleven.
- Specification-lookup calls to the inside sales desk fell noticeably over the
  following two quarters, though Halloway did not instrument this precisely.
- Time to publish a new SKU with complete data dropped from several days to
  under one day.

Halloway did not measure a revenue attribution figure, and Meridian therefore
does not claim one.

## Invented quotation

> "The filters finally work the way our customers actually shop. That is the
> part the sales desk noticed first."
> — invented Ecommerce Manager, Halloway Industrial Supply

## Why this engagement is representative

Halloway matches the primary persona closely: mid-size trade distributor, deep
technical catalog, Magento, growth by acquisition, and a data problem nobody
owned. It is the pattern Meridian's outbound material should describe.
