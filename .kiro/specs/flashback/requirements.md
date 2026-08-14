# Requirements Document

## Introduction

FLASHBACK is a private, temporary photo and video archive of a single night. Version 1 serves one event: Qlick QRave, an underground queer electronic rave in Miami. The Photographer shoots and edits the media, ingests optimized derivatives into private storage, and hands access to the Organizer. The Organizer privately distributes an attendee URL and one shared access code through the event's existing Eventbrite channel. Attendees enter the code, revisit the night, and can request removal of any media without identifying themselves. After the expiration timestamp the archive goes dark.

The primary requirement is protecting the people depicted in the media. The secondary requirement is shipping the same day. The system collects no attendee identity, runs entirely on Netlify Free tier services, and stores nothing in a conventional database.

Scope boundaries for v1: no attendee accounts, no admin upload UI, no scheduled auto-purge, no consent-QR subject-control system, no analytics of any kind, no public media URLs.

Sequencing within v1. The Day 1 core is the authorization gate, protected media delivery, the Attendee_Code, the Archive_View, the removal flow, the disable control, expiration, ingest with verified metadata stripping, the visual identity, and the deployed security verification. Deferred past Day 1: the full 34-property test suite, reduced on Day 1 to a focused security-critical set; Organizer conveniences beyond the controls enumerated in Requirement 6; and secondary visual polish. Every requirement in this document holds for the finished product. Scope is expressed as sequencing in tasks.md, not as removal of any requirement recorded here.

## Glossary

- **FLASHBACK**: The overall product name and the deployed Next.js application.
- **Archive**: The single Qlick QRave collection of Media_Items, its state, and its expiration timestamp.
- **Access_Screen**: The unauthenticated route `/` where an Attendee enters the Attendee_Code.
- **Archive_View**: The authenticated route `/archive` that renders the Featured_Video and the photograph grid.
- **Admin_View**: The route `/admin` that renders Organizer controls.
- **Access_API**: The server route `POST /api/access` that verifies the Attendee_Code and issues an Attendee_Session.
- **Media_API**: The server route `GET /api/media/[id]` that authorizes a request and streams a Media_Item's bytes.
- **Removal_API**: The server route `POST /api/removal` that records a Removal_Request.
- **Admin_API**: The server routes under `/api/admin/*` that perform Organizer operations.
- **Ingest_Script**: The Node.js command `npm run ingest <directory>` run on the Photographer's own machine, which optimizes source files, strips metadata, assigns Media_IDs, and writes to the Blob_Store.
- **Blob_Store**: The site-wide Netlify Blobs store, accessed via `getStore`, that holds all media bytes, metadata documents, secret hashes, and removal records.
- **Photographer**: The person who shot and edited the media and who operates the Ingest_Script. Holds the Organizer_Secret.
- **Organizer**: The Qlick promoter (Sabrina) who reviews the Archive, controls its state, and distributes access to Attendees. Holds the Organizer_Secret.
- **Attendee**: A person who attended Qlick QRave and received the attendee URL and Attendee_Code from the Organizer. Has no account.
- **Attendee_Code**: The single shared secret that grants Attendee access to the Archive. Rotatable by the Organizer.
- **Organizer_Secret**: The separate, environment-variable-only secret that grants access to Admin_View and Admin_API.
- **Attendee_Session**: A signed, HttpOnly, Secure, SameSite=Strict cookie proving a successful Attendee_Code entry.
- **Organizer_Session**: A signed, HttpOnly, Secure, SameSite=Strict cookie proving a successful Organizer_Secret entry.
- **Media_Item**: One web-optimized photograph or one compressed video in the Archive, identified by a Media_ID and labeled with a Reference_Label.
- **Media_ID**: An opaque, randomly generated, unguessable identifier for a Media_Item, containing no filename, date, or sequence information.
- **Reference_Label**: The human-visible identifier displayed with a Media_Item, formatted `QLK NNN`.
- **Grid_Thumbnail**: The small derivative of a photograph Media_Item that the Archive_View renders in the photograph grid.
- **Inline_Thumbnail**: A Grid_Thumbnail embedded directly in an authenticated HTML response as a base64 `data:` URI instead of being fetched through the Media_API.
- **Full_Derivative**: The web-optimized full-size derivative of a photograph Media_Item, delivered exclusively through the Media_API.
- **Featured_Video**: The Media_Item of type video that the Archive_View presents above the photograph grid.
- **Removal_Request**: An anonymous record stating that someone wants a specified Media_Item removed, with an optional free-text note.
- **Archive_State**: The Archive's operational state, one of `LIVE` or `DISABLED`.
- **Expiration_Timestamp**: The UTC instant after which the Archive refuses all Attendee access.
- **Hidden**: The per-Media_Item flag that makes a Media_Item unavailable to Attendees while its bytes remain in the Blob_Store.
- **Deleted**: The per-Media_Item state in which the Media_Item's bytes have been removed from the Blob_Store.
- **Strong_Read**: A Netlify Blobs read performed with strong consistency, used where stale data would be a safety failure.
- **Credit_Allowance**: The Netlify Free plan monthly allowance of 300 credits. Exhausting the Credit_Allowance pauses every project owned by the team until the next billing cycle, and the Free plan offers no auto-recharge.
- **Verification_Item**: A Media_Item ingested solely as the target of destructive checks in the deployed verification procedure, excluded from Organizer distribution and deleted when the procedure completes.

## Requirements

### Requirement 1: Attendee Authentication

**User Story:** As an Attendee, I want to enter one short code to reach the archive, so that I can revisit the night without creating an account or giving up any personal information.

#### Acceptance Criteria

1. THE Access_Screen SHALL render the FLASHBACK name, the event name QLICK QRAVE, the phrase identifying the Archive as private, one text input for the Attendee_Code, and one submit control.
2. THE Access_Screen SHALL render zero photographs and zero video elements sourced from the Archive.
3. WHEN an Attendee submits a value to the Access_API, THE Access_API SHALL compare a salted hash of the submitted value against the stored Attendee_Code hash using a constant-time comparison.
4. WHEN the Access_API receives a submitted value whose hash matches the stored Attendee_Code hash, THE Access_API SHALL issue an Attendee_Session cookie with the attributes HttpOnly, Secure, SameSite=Strict, and Path=/, and a lifetime of 12 hours.
5. IF the Access_API receives a submitted value whose hash does not match the stored Attendee_Code hash, THEN THE Access_API SHALL respond with HTTP 401 and a response body containing no information about the expected value, and SHALL issue no session cookie.
6. THE Access_API SHALL accept the Attendee_Code case-insensitively and SHALL ignore leading whitespace, trailing whitespace, and internal spaces in the submitted value.
7. THE FLASHBACK application SHALL generate every Attendee_Code as 8 to 12 characters drawn from an alphabet that excludes the characters `0`, `O`, `1`, `I`, and `L`, so that a person can transcribe the Attendee_Code from a phone screen.
8. THE Access_API SHALL count failed submissions per client IP address over a rolling 60-second window.
9. IF a client IP address exceeds 10 failed submissions within a 60-second window, THEN THE Access_API SHALL respond with HTTP 429.
10. THE FLASHBACK application SHALL exclude the Attendee_Code plaintext, the Attendee_Code hash, the Attendee_Code salt, and the Organizer_Secret from every response body, every client-side JavaScript bundle, and every committed Git file.
11. WHEN the Access_API issues an Attendee_Session, THE Access_API SHALL redirect the Attendee to the Archive_View.

### Requirement 2: Protected Media Delivery

**User Story:** As a person depicted in the media, I want the media to be unreachable without authorization, so that an obscure or shared URL cannot expose me.

#### Acceptance Criteria

1. THE FLASHBACK application SHALL store all Media_Item bytes in the Blob_Store and SHALL store zero Media_Item bytes in the repository `public` directory or any other statically served path.
2. WHEN the Media_API receives a request, THE Media_API SHALL verify, in order, that the request carries a valid unexpired Attendee_Session or a valid unexpired Organizer_Session, that the Archive_State is `LIVE`, that the current time precedes the Expiration_Timestamp, and that the requested Media_Item is neither Hidden nor Deleted, before reading any bytes from the Blob_Store.
3. IF the Media_API receives a request carrying no valid session cookie, THEN THE Media_API SHALL respond with HTTP 401 and zero media bytes.
4. IF the Media_API receives a request for a Media_ID that is absent from the Archive metadata, THEN THE Media_API SHALL respond with HTTP 404 and zero media bytes.
5. IF the Media_API receives an Attendee_Session request while the Archive_State is `DISABLED`, THEN THE Media_API SHALL respond with HTTP 403 and zero media bytes.
6. IF the Media_API receives an Attendee_Session request at a time at or after the Expiration_Timestamp, THEN THE Media_API SHALL respond with HTTP 403 and zero media bytes.
7. IF the Media_API receives a request for a Media_Item whose Hidden flag is set, THEN THE Media_API SHALL respond with HTTP 404 and zero media bytes.
8. WHEN the Media_API returns media bytes, THE Media_API SHALL set the response header `Cache-Control` to `private, max-age=60` and SHALL set `Vary` to `Cookie`.
9. THE Ingest_Script SHALL generate each Media_ID from at least 128 bits of cryptographically secure randomness.
10. THE Archive_View SHALL deliver every Media_Item either through a Media_API URL or, for a Grid_Thumbnail only, as an Inline_Thumbnail within an authenticated response, and SHALL expose zero original filenames, zero publicly reachable media URLs, and zero statically served media paths in markup, URLs, attributes, or JSON payloads.
11. WHEN the Media_API evaluates the Archive_State, the Expiration_Timestamp, or a Media_Item Hidden flag, THE Media_API SHALL obtain those values through a Strong_Read.
12. THE Ingest_Script SHALL generate each Media_ID such that the Media_ID contains no substring of the source filename, no source file extension, no source modification date, and no ingest ordinal.
13. THE Archive_View SHALL deliver every Full_Derivative and every video Media_Item exclusively through a Media_API URL.
14. THE Archive_View SHALL emit the complete set of Inline_Thumbnails for the photograph grid within an HTML response of at most 5 MB, so that the response remains within the 6 MB Netlify buffered response limit.
15. WHILE a request carries no valid unexpired Attendee_Session and no valid unexpired Organizer_Session, THE FLASHBACK application SHALL emit zero Inline_Thumbnails and zero Media_ID values in the response body.
16. WHILE the current time is at or after the Expiration_Timestamp, THE FLASHBACK application SHALL emit zero Inline_Thumbnails in every response.
17. THE FLASHBACK application SHALL accept, as the recorded and bounded consequence of criterion 8, that a Media_Item whose Hidden flag is set or whose bytes are Deleted remains viewable for at most 60 seconds in the private browser cache of an Attendee who retrieved that Media_Item before the change.
18. THE Media_API SHALL evaluate the Hidden flag, the Deleted state, the Archive_State, and the Expiration_Timestamp on every new request, so that the disable control and the Expiration_Timestamp take effect within the interval specified in Requirement 14 independently of any private browser cache.

### Requirement 3: Video Playback

**User Story:** As an Attendee, I want to watch and seek through the video without it blasting audio, so that I can view it anywhere and the original room audio is not broadcast by surprise.

#### Acceptance Criteria

1. WHEN the Media_API receives a request containing a `Range` header for a video Media_Item, THE Media_API SHALL respond with HTTP 206, a `Content-Range` header describing the returned byte range, and only the requested bytes.
2. THE Media_API SHALL set the response header `Accept-Ranges` to `bytes` for every video Media_Item response.
3. THE Archive_View SHALL render the Featured_Video with autoplay disabled and with the `muted` attribute set by default.
4. THE Archive_View SHALL render native playback controls for the Featured_Video, including a seek control and a volume control.
5. THE Ingest_Script SHALL accept a per-file option to discard the source audio track and SHALL accept a per-file option to substitute an audio track from a supplied file.
6. THE Archive_View SHALL render the Featured_Video without a download control and SHALL set the `controlsList` attribute to `nodownload`.

### Requirement 4: Media Ingest and Metadata Stripping

**User Story:** As the Photographer, I want to publish web-optimized copies from my own machine, so that no location data, camera identity, or original file reaches an Attendee and my originals stay untouched.

#### Acceptance Criteria

1. WHEN the Photographer runs the Ingest_Script against a directory, THE Ingest_Script SHALL process every file with a supported photograph or video extension in that directory and SHALL leave every source file unmodified.
2. WHEN the Ingest_Script processes a photograph, THE Ingest_Script SHALL produce a derivative whose longest edge is at most 2400 pixels and whose encoded size is at most 1 MB.
3. WHEN the Ingest_Script processes a photograph, THE Ingest_Script SHALL remove all EXIF, IPTC, XMP, GPS, camera serial number, creator contact, and embedded face-region metadata from the derivative.
4. WHEN the Ingest_Script writes a derivative to the Blob_Store, THE Ingest_Script SHALL use a site-wide store obtained via `getStore` and SHALL use a key derived from the Media_ID.
5. IF the Ingest_Script encounters a source file with a RAW extension, THEN THE Ingest_Script SHALL skip that file and SHALL report the skipped filename to the Photographer.
6. WHEN the Ingest_Script completes a run, THE Ingest_Script SHALL write an Archive metadata document to the Blob_Store containing, for each Media_Item, the Media_ID, the media type, the Reference_Label, the derivative dimensions, the byte length, and the Hidden flag defaulted to false.
7. THE Ingest_Script SHALL assign Reference_Labels in the format `QLK NNN` with zero-padded three-digit ascending numbering starting at `QLK 001`.
8. THE Ingest_Script SHALL produce every video derivative as an MP4 file of at most 18 MB.
9. IF the Ingest_Script cannot process a source file, THEN THE Ingest_Script SHALL report the filename and the failure reason to the Photographer and SHALL continue processing the remaining files.
10. THE Ingest_Script SHALL read the Blob_Store credentials from environment variables and SHALL exclude those credentials from committed Git files.

### Requirement 5: Anonymous Removal Requests

**User Story:** As someone who appears in a photograph, I want to have it taken down without proving who I am, so that asking costs me nothing and exposes me to nothing.

#### Acceptance Criteria

1. THE Archive_View SHALL render a removal control adjacent to every visible Media_Item.
2. THE Removal_API SHALL treat the Media_ID as the only required field of a Removal_Request and SHALL treat a free-text note of at most 1000 characters as the only optional field.
3. IF the Removal_API receives a payload containing a field other than the Media_ID and the note, THEN THE Removal_API SHALL discard the additional field and SHALL exclude the additional field from the stored removal record.
4. WHEN the Removal_API accepts a Removal_Request, THE Removal_API SHALL set the Hidden flag of the referenced Media_Item to true before sending a response.
5. WHEN the Removal_API accepts a Removal_Request, THE Removal_API SHALL write a removal record to the Blob_Store containing a random record identifier, the Media_ID, the submission timestamp, the optional note, and a review status of `PENDING`.
6. THE Removal_API SHALL exclude the requesting client IP address, the user agent string, and every other request-derived identifier from the stored removal record.
7. WHEN the Removal_API accepts a Removal_Request, THE Archive_View SHALL display a confirmation stating that the Media_Item is already hidden.
8. IF the Removal_API receives a request carrying no valid unexpired Attendee_Session and no valid unexpired Organizer_Session, THEN THE Removal_API SHALL respond with HTTP 401.
9. IF a client IP address exceeds 20 accepted Removal_Requests within a 60-second window, THEN THE Removal_API SHALL respond with HTTP 429.

### Requirement 6: Organizer Controls

**User Story:** As the Organizer, I want a small set of decisive controls, so that I can review the archive, distribute it on my own terms, and shut it off instantly if anyone raises a concern.

#### Acceptance Criteria

1. THE Admin_View SHALL display the event name, the Archive_State, the Expiration_Timestamp, the count of photograph Media_Items, the count of video Media_Items, and the count of Removal_Requests whose review status is `PENDING`.
2. THE Admin_View SHALL render controls for disabling the Archive, enabling the Archive, changing the Expiration_Timestamp, rotating the Attendee_Code, hiding a Media_Item, restoring a Media_Item, restoring every Media_Item that is not Deleted, deleting a Media_Item, deleting all Media_Items, reviewing a Removal_Request, and reviewing every pending Removal_Request together.
3. WHEN the Organizer invokes the disable control, THE Admin_API SHALL persist the Archive_State value `DISABLED` such that the next Media_API Strong_Read returns `DISABLED`.
4. WHILE the Archive_State is `DISABLED`, THE Access_API SHALL respond with HTTP 403 to every submitted Attendee_Code and SHALL issue no Attendee_Session.
5. WHEN the Organizer invokes the enable control, THE Admin_API SHALL set the Archive_State to `LIVE`.
6. WHEN the Organizer invokes the rotate control, THE Admin_API SHALL generate a new Attendee_Code, SHALL persist the salted hash of the new Attendee_Code, and SHALL display the new plaintext Attendee_Code to the Organizer exactly once.
7. WHEN the Admin_API persists a new Attendee_Code, THE Admin_API SHALL invalidate every Attendee_Session issued before that rotation.
8. WHEN the Organizer changes the Expiration_Timestamp, THE Admin_API SHALL persist the submitted value, and THE Archive_View SHALL display the persisted value on the next render.
9. WHEN the Organizer invokes the hide control for a Media_Item, THE Admin_API SHALL set the Hidden flag of that Media_Item to true and SHALL retain the bytes of that Media_Item in the Blob_Store.
10. WHEN the Organizer invokes the restore control for a Media_Item, THE Admin_API SHALL set the Hidden flag of that Media_Item to false.
11. WHEN the Organizer invokes the delete control for a Media_Item and confirms the action, THE Admin_API SHALL remove the bytes of that Media_Item from the Blob_Store and SHALL mark that Media_Item as Deleted.
12. WHEN the Organizer invokes the delete-all-media control and confirms the action, THE Admin_API SHALL remove the bytes of every Media_Item from the Blob_Store and SHALL mark every Media_Item as Deleted.
13. THE Admin_API SHALL require an explicit confirmation step for the delete control and for the delete-all-media control before removing any bytes from the Blob_Store.
14. WHEN the Organizer marks a Removal_Request as reviewed, THE Admin_API SHALL update the review status of that record and SHALL leave the Hidden flag of the referenced Media_Item set to true.
15. THE Admin_View SHALL render previews of Hidden Media_Items through the Media_API authorized by the Organizer_Session.
16. WHEN the Organizer invokes the restore-all control and confirms the action, THE Admin_API SHALL set the Hidden flag to false on every Media_Item that is not Deleted.
17. WHEN the Organizer invokes the restore-all control, THE Admin_View SHALL require a confirmation step stating the count of Media_Items that hold a Removal_Request with review status `PENDING` and that the action will make visible to Attendees again.
18. THE Admin_View SHALL render a bulk review of every Removal_Request whose review status is `PENDING`, displaying for each record the Reference_Label, the submission timestamp, and the optional note.
19. THE Admin_View SHALL render one control that marks a selected set of Removal_Requests as reviewed in a single operation and one control that dismisses a selected set of Removal_Requests in a single operation.
20. THE Admin_View SHALL display a pending-removal indicator on every Media_Item that holds a Removal_Request with review status `PENDING`.
21. WHILE a Media_Item holds a Removal_Request with review status `PENDING`, THE Admin_View SHALL require a confirmation step naming that Removal_Request before the Admin_API sets the Hidden flag of that Media_Item to false.
22. THE Removal_API SHALL accept a Removal_Request carrying only the fields specified in Requirement 5, so that the Organizer recovery controls specified in criteria 16 through 21 add zero identity collection, zero justification, and zero additional steps to the removal path.

### Requirement 7: Organizer Authentication and Privilege Separation

**User Story:** As the Photographer, I want organizer access to depend on a separate secret, so that a leaked attendee code can never let someone disable, delete, or rotate anything.

#### Acceptance Criteria

1. THE Admin_API SHALL verify the Organizer_Secret against a value read from an environment variable using a constant-time comparison.
2. IF the Admin_View or the Admin_API receives a request carrying only an Attendee_Session, THEN THE Admin_API SHALL respond with HTTP 403 and SHALL perform no state change.
3. IF the Admin_View or the Admin_API receives a request carrying no valid session cookie, THEN THE Admin_API SHALL respond with HTTP 401 and SHALL perform no state change.
4. WHEN the Organizer submits a value matching the Organizer_Secret, THE Admin_API SHALL issue an Organizer_Session cookie with the attributes HttpOnly, Secure, SameSite=Strict, and Path=/, and a lifetime of 12 hours.
5. THE FLASHBACK application SHALL derive Organizer privileges exclusively from a valid Organizer_Session and SHALL derive zero Organizer privileges from an Attendee_Session.
6. THE Admin_API SHALL require a valid Organizer_Session for every state-changing operation.
7. IF the Admin_API receives a state-changing request whose `Origin` header differs from the deployed site origin, THEN THE Admin_API SHALL respond with HTTP 403 and SHALL perform no state change.
8. THE FLASHBACK application SHALL sign every session cookie with a secret read from an environment variable.
9. IF the FLASHBACK application receives a session cookie whose signature fails verification, THEN THE FLASHBACK application SHALL treat the request as carrying no session.

### Requirement 8: Expiration Behavior

**User Story:** As an Attendee, I want the archive to visibly count down and then end, so that it is clear this is a temporary window and not a permanent record of the night.

#### Acceptance Criteria

1. THE Archive_View SHALL display the remaining time until the Expiration_Timestamp in days, hours, and minutes.
2. THE FLASHBACK application SHALL default the Expiration_Timestamp to 12 days after the initial Archive creation.
3. WHILE the current time is at or after the Expiration_Timestamp, THE Access_API SHALL respond with HTTP 403 to every submitted Attendee_Code and SHALL issue no Attendee_Session.
4. WHILE the current time is at or after the Expiration_Timestamp, THE Archive_View SHALL respond to an Attendee_Session request with the message `THIS FLASHBACK HAS ENDED.` and SHALL render zero Media_Items.
5. WHILE the current time is at or after the Expiration_Timestamp, THE Access_Screen SHALL display the message `THIS FLASHBACK HAS ENDED.` in place of the Attendee_Code input.
6. WHILE the current time is at or after the Expiration_Timestamp, THE Admin_View SHALL render for a request carrying a valid Organizer_Session.
7. WHILE the current time is at or after the Expiration_Timestamp, THE Admin_API SHALL accept a change to the Expiration_Timestamp.
8. WHEN the Expiration_Timestamp passes, THE FLASHBACK application SHALL retain the bytes of every Media_Item in the Blob_Store until the Organizer invokes a delete control.
9. THE FLASHBACK application SHALL evaluate the Expiration_Timestamp on the server for every authorization decision and SHALL treat client-supplied time values as display-only.

### Requirement 9: Visual Identity and Attendee Experience

**User Story:** As an Attendee, I want the archive to feel like the night it came from, so that revisiting it feels like the rave rather than like a client photo portal.

#### Acceptance Criteria

1. THE Archive_View SHALL present the Featured_Video above the photograph grid and SHALL give the photographs the largest share of the viewport at every supported breakpoint.
2. THE FLASHBACK application SHALL render a usable single-column layout at a viewport width of 375 CSS pixels.
3. THE Archive_View SHALL display the Reference_Label with every Media_Item.
4. THE Archive_View SHALL display a privacy notice asking viewers not to identify, tag, download, screenshot, record, or redistribute the people depicted, and pointing to the removal control.
5. WHERE the user agent reports `prefers-reduced-motion: reduce`, THE FLASHBACK application SHALL disable non-essential animation and SHALL retain all navigation and playback functionality.
6. THE FLASHBACK application SHALL provide a text alternative for every non-decorative image and SHALL maintain a contrast ratio of at least 4.5:1 between body text and the underlying background.
7. THE FLASHBACK application SHALL support full keyboard operation of the Attendee_Code input, the submit control, the video controls, and every removal control.
8. THE FLASHBACK application SHALL render the footer text `Built with PLUR by film.fyi` with a hyperlink on `film.fyi` only.
9. THE FLASHBACK application SHALL render zero hire-me content, contact forms, newsletter signups, portfolio links, advertising, and lead-capture fields.
10. THE Archive_View SHALL render the remaining-time countdown outside every ARIA live region, so that an assistive technology announces the countdown only when the user navigates to the countdown.
11. THE Archive_View SHALL expose the remaining time until the Expiration_Timestamp as static text reachable by keyboard navigation and by assistive technology.

### Requirement 10: Download and Screenshot Deterrents

**User Story:** As a person depicted in the media, I want casual saving to be inconvenient, so that the archive is not trivially copied out, while nobody is misled about what a website can enforce.

#### Acceptance Criteria

1. THE Archive_View SHALL render zero download controls for any Media_Item.
2. WHEN a pointer drag begins on a Media_Item image, THE Archive_View SHALL cancel the default drag behavior.
3. WHEN a context-menu event occurs on a Media_Item image, THE Archive_View SHALL cancel the default context menu.
4. THE FLASHBACK application SHALL describe download and screenshot measures as deterrents and SHALL make zero claims of screenshot prevention.

### Requirement 11: No Tracking and No Indexing

**User Story:** As an Attendee, I want the archive to know nothing about me, so that visiting it leaves no trail tied to my identity.

#### Acceptance Criteria

1. THE FLASHBACK application SHALL collect zero attendee names, email addresses, phone numbers, Eventbrite records, social accounts, demographic attributes, geolocation values, profile records, facial recognition data, and advertising identifiers.
2. THE FLASHBACK application SHALL include zero analytics, session replay, heatmap, fingerprinting, and advertising scripts, and SHALL issue zero requests to third-party analytics or advertising endpoints.
3. THE FLASHBACK application SHALL emit the `X-Robots-Tag` response header with the value `noindex, nofollow` on every route.
4. THE FLASHBACK application SHALL render a `robots` meta tag with the value `noindex, nofollow` on every page.
5. THE FLASHBACK application SHALL serve a `robots.txt` file disallowing all paths for all user agents.
6. THE FLASHBACK application SHALL treat server-side session verification as the sole access boundary and SHALL derive zero authorization from `robots.txt`, meta tags, or URL obscurity.

### Requirement 12: HTTP and Cache Security

**User Story:** As the Photographer, I want the delivery layer configured correctly, so that protected media does not leak through a shared cache, a referrer, or an embedded frame.

#### Acceptance Criteria

1. THE FLASHBACK application SHALL emit a `Content-Security-Policy` header on every HTML response that restricts `default-src` to the site origin and sets `frame-ancestors` to `'none'`.
2. THE FLASHBACK application SHALL emit `X-Content-Type-Options: nosniff` on every response.
3. THE FLASHBACK application SHALL emit `Referrer-Policy: no-referrer` on every response.
4. THE FLASHBACK application SHALL emit a `Permissions-Policy` header denying camera, microphone, and geolocation access.
5. THE FLASHBACK application SHALL emit `Strict-Transport-Security` with a `max-age` of at least 31536000 on every response.
6. THE FLASHBACK application SHALL emit `Cache-Control: private, max-age=60` together with `Vary: Cookie` on every Media_API response that carries media bytes.
7. THE FLASHBACK application SHALL serve every route over HTTPS.
8. THE FLASHBACK application SHALL restrict every Media_API response to the private cache of the requesting user agent by emitting the `private` directive and by omitting the `public` directive, the `s-maxage` directive, and every other shared-cache directive, so that no CDN cache and no other shared cache stores media bytes.
9. THE FLASHBACK application SHALL emit `Cache-Control: private, no-store` on every authenticated HTML response, including every Archive_View response and every Admin_View response, because those responses carry the Media_ID index, the Inline_Thumbnails, and, in the render immediately following a rotation, the Attendee_Code plaintext.

### Requirement 13: Platform and Cost Constraints

**User Story:** As the Photographer, I want everything to run on free Netlify services, so that the archive costs nothing to keep alive and depends on no additional vendor.

#### Acceptance Criteria

1. THE FLASHBACK application SHALL depend exclusively on Next.js App Router, TypeScript, Tailwind CSS, Netlify hosting, Netlify server routes or Netlify Functions, and Netlify Blobs for runtime infrastructure.
2. THE FLASHBACK application SHALL depend on zero external database, authentication, storage, streaming, and analytics services.
3. THE FLASHBACK application SHALL operate within the Netlify Free tier limits of a 6 MB function request and response payload, a 20 MB streamed response, and a 60-second function execution.
4. THE FLASHBACK application SHALL access the Blob_Store through a site-wide store obtained via `getStore` and SHALL use zero deploy-scoped stores.
5. WHEN the FLASHBACK application reads an unpopulated Blob_Store, THE FLASHBACK application SHALL seed the Attendee_Code salted hash and the Expiration_Timestamp from environment variables and SHALL persist both values to the Blob_Store.
6. THE FLASHBACK application SHALL read the Organizer_Secret exclusively from an environment variable and SHALL persist zero copies of the Organizer_Secret to the Blob_Store.
7. IF a required behavior cannot be implemented within the Netlify Free tier, THEN THE FLASHBACK implementation SHALL halt and report the constraint to the Photographer before introducing any additional service.
8. WHEN an Attendee loads the Archive_View, THE FLASHBACK application SHALL render the complete photograph grid using at most 2 function invocations, excluding invocations caused by Attendee interaction with an individual Media_Item.
9. THE FLASHBACK application SHALL permit private browser caching of Media_API byte responses as specified in Requirement 2 criterion 8, so that a repeated view and a video seek consume fewer function invocations than one invocation per byte range.
10. THE verification procedure SHALL confirm the 60-second synchronous function execution limit, the 6 MB buffered payload limit, and the 20 MB streamed response limit by measurement against the deployed Netlify site, and SHALL treat published platform documentation as insufficient evidence.
11. THE FLASHBACK deliverable SHALL document the Credit_Allowance failure mode in the repository README, stating that exhausting the Credit_Allowance pauses the deployed site until the next billing cycle and that the Archive can therefore become unreachable before the Expiration_Timestamp elapses.
12. THE FLASHBACK deliverable SHALL document the location of the Netlify usage dashboard so that the Organizer can read the remaining Credit_Allowance.

### Requirement 14: Deployed Security Verification

**User Story:** As the Photographer, I want each protection confirmed against the live site, so that I can hand the archive to the Organizer knowing the guarantees hold in production rather than only in a local build.

#### Acceptance Criteria

1. THE verification procedure SHALL execute against the deployed Netlify site URL and SHALL treat a successful local build as insufficient evidence.
2. THE verification procedure SHALL confirm that an incorrect Attendee_Code yields HTTP 401 and no session cookie.
3. THE verification procedure SHALL confirm that a correct Attendee_Code yields an Attendee_Session and access to the Archive_View.
4. THE verification procedure SHALL confirm that a request to the Archive_View carrying no session cookie yields a redirect to the Access_Screen or HTTP 401, and zero Media_Item references.
5. THE verification procedure SHALL confirm that a request to a photograph Media_API URL carrying no session cookie yields HTTP 401 and zero media bytes.
6. THE verification procedure SHALL confirm that a request to a video Media_API URL carrying no session cookie yields HTTP 401 and zero media bytes.
7. THE verification procedure SHALL confirm that a Media_API URL copied into a browser session holding no Attendee_Session yields HTTP 401 and zero media bytes.
8. THE verification procedure SHALL confirm that a request for a randomly generated Media_ID carrying a valid Attendee_Session yields HTTP 404 and zero media bytes.
9. THE verification procedure SHALL confirm that a request for a Hidden Verification_Item carrying a valid Attendee_Session yields HTTP 404 and zero media bytes.
10. THE verification procedure SHALL confirm that, within 5 seconds of the disable control being invoked, an Attendee_Session request to the Media_API yields HTTP 403.
11. THE verification procedure SHALL confirm that, after the enable control is invoked, an Attendee_Session request to the Media_API yields HTTP 200.
12. THE verification procedure SHALL confirm that an Expiration_Timestamp set in the past causes the Access_API to yield HTTP 403 and the Access_Screen to display `THIS FLASHBACK HAS ENDED.`
13. THE verification procedure SHALL confirm that a Removal_Request submitted with only the Media_ID of the Verification_Item yields a stored removal record and an immediately Hidden Verification_Item.
14. THE verification procedure SHALL confirm that a request to the Admin_View and to each Admin_API state-changing route carrying only an Attendee_Session yields HTTP 403 and no state change.
15. THE verification procedure SHALL confirm that a request to the Admin_View carrying a valid Organizer_Session yields the Admin_View with the counts specified in Requirement 6.
16. THE verification procedure SHALL confirm that an expired Attendee_Session cookie yields HTTP 401 from the Media_API.
17. THE verification procedure SHALL target every destructive check at the Verification_Item and SHALL target zero destructive checks at a Media_Item intended for Attendee viewing.
18. WHEN the verification procedure completes, THE verification procedure SHALL leave the Archive_State set to `LIVE`, SHALL leave the Expiration_Timestamp set to the value the Organizer intends, SHALL leave zero Media_Items intended for Attendee viewing Hidden, and SHALL leave zero Media_Items intended for Attendee viewing Deleted.
19. WHEN the verification procedure completes, THE verification procedure SHALL delete the Verification_Item and SHALL mark every Removal_Request created during the procedure as reviewed.
20. THE verification procedure SHALL confirm that, after the rotate control is invoked on the deployed site, the new Attendee_Code yields an Attendee_Session from the Access_API.
21. THE verification procedure SHALL confirm that, after the rotate control is invoked on the deployed site, the previous Attendee_Code yields HTTP 401 from the Access_API.
22. THE verification procedure SHALL confirm that, after the rotate control is invoked on the deployed site, an Attendee_Session issued before that rotation yields HTTP 401 from the Media_API.
23. THE verification procedure SHALL confirm that a Media_API response carrying media bytes sets `Cache-Control` to `private, max-age=60`, sets `Vary` to `Cookie`, and carries zero shared-cache directives.
24. THE verification procedure SHALL confirm that an Archive_View response returned to a request carrying no valid session cookie contains zero `data:` URIs and zero Media_ID values.
25. THE verification procedure SHALL confirm that an authenticated Archive_View response sets `Cache-Control` to `private, no-store` and remains at most 5 MB with the complete photograph grid rendered.

### Requirement 15: Organizer Handoff

**User Story:** As the Organizer, I want to receive everything I need to review and distribute the archive myself, so that I control who gets access and the Photographer never receives the attendee list.

#### Acceptance Criteria

1. THE FLASHBACK deliverable SHALL provide the Organizer with the attendee URL, the Attendee_Code, the Admin_View URL, and the Organizer_Secret.
2. THE FLASHBACK application SHALL provide zero mechanism for importing, requesting, storing, or displaying an attendee list, attendee email addresses, and Eventbrite data.
3. WHEN the Admin_View renders immediately following Attendee_Code generation or Attendee_Code rotation, THE Admin_View SHALL display distribution text containing the archive URL and the active Attendee_Code plaintext, so that the Organizer can copy that text into the event's own channel.
4. WHILE the Admin_View renders at any time other than immediately following Attendee_Code generation or Attendee_Code rotation, THE Admin_View SHALL display distribution text containing the archive URL and a placeholder in place of the Attendee_Code plaintext, together with the rotate control specified in Requirement 6.
5. THE FLASHBACK application SHALL persist zero copies of the Attendee_Code plaintext to the Blob_Store and SHALL write zero copies of the Attendee_Code plaintext to any log, error message, and telemetry output.
6. THE FLASHBACK deliverable SHALL document the Ingest_Script command, the required environment variables by name, and the disable control location in the repository README.
