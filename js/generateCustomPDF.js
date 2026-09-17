document.getElementById("generateQCAB").addEventListener("click", async () => {

    const customQuestions = window.customQuestions || [];

    if (customQuestions.length === 0) {
        alert("Add at least one custom question first!");
        return;
    }

    const supabaseClient = window.supabaseClient;

    if (!supabaseClient) {
        alert("Authentication system is not ready. Please refresh the page and try again.");
        return;
    }

    const { data: { session }, error: sessionError } =
        await supabaseClient.auth.getSession();

    if (sessionError || !session) {
        return;
    }

    // ==========================================
    // CHECK PREMIUM ACCESS FIRST
    // ==========================================

    const { data: accessData, error: accessError } =
        await supabaseClient
            .from("user_access")
            .select("access_level, access_expires_at")
            .eq("user_id", session.user.id)
            .maybeSingle();

    if (accessError) {

        console.error(
            "Premium access check error:",
            accessError
        );

        alert(
            "Could not verify your account access. Please try again."
        );

        return;
    }

    const accessLevel =
        String(accessData?.access_level || "free")
            .trim()
            .toLowerCase();

    const accessExpiresAt =
        accessData?.access_expires_at || null;

    const premiumActive =
        (accessLevel === "paid" || accessLevel === "premium") &&
        (
            !accessExpiresAt ||
            new Date(accessExpiresAt).getTime() > Date.now()
        );


    // ==========================================
    // PREMIUM USERS: UNLIMITED GENERATION
    // ==========================================

    if (premiumActive) {

        console.log("Premium user detected - unlimited generation.");

        if (window.updateUsageDisplay) {

            window.updateUsageDisplay(
                0,
                "paid",
                accessExpiresAt
            );

        }

    } else {

        // ==========================================
        // FREE USERS: USE ONE FREE GENERATION
        // ==========================================
        // Free usage is stored directly in user_access.
        // No user_usage table or RPC is required.

        const { data: currentAccess, error: currentAccessError } =
            await supabaseClient
                .from("user_access")
                .select("generations_used")
                .eq("user_id", session.user.id)
                .maybeSingle();

        if (currentAccessError || !currentAccess) {

            console.error(
                "Free generation access fetch error:",
                currentAccessError
            );

            alert(
                "Could not verify your free generation. Please try again."
            );

            return;
        }

        const generationsUsed =
            Number(currentAccess.generations_used || 0);


        // ==========================================
        // NO GENERATIONS LEFT
        // ==========================================

        if (generationsUsed >= 5) {

            if (window.updateUsageDisplay) {

                window.updateUsageDisplay(0);

            }

            alert(
                "You have used all 5 free QCAB generations. Please upgrade to Premium to continue."
            );

            return;
        }


        // ==========================================
        // USE ONE FREE GENERATION
        // ==========================================

        const newGenerationsUsed =
            generationsUsed + 1;

        const { error: updateAccessError } =
            await supabaseClient
                .from("user_access")
                .update({
                    generations_used: newGenerationsUsed
                })
                .eq("user_id", session.user.id);

        if (updateAccessError) {

            console.error(
                "Free generation update error:",
                updateAccessError
            );

            alert(
                "Could not verify your free generation. Please try again."
            );

            return;
        }


        // ==========================================
        // UPDATE FREE COUNTER
        // ==========================================

        if (window.updateUsageDisplay) {

            window.updateUsageDisplay(
                Math.max(
                    0,
                    5 - newGenerationsUsed
                )
            );

        }

    }


    // ==========================================
    // NUMBER QUESTIONS
    // ==========================================

    customQuestions.forEach((q, i) => {

        q.question_number =
            i + 1;

    });


    // ==========================================
    // GENERATE PDF
    // ==========================================

    try {

        await generateQCABPDF(
            customQuestions
        );

    } catch (error) {

        console.error(
            "QCAB generation failed:",
            error
        );


        // ==========================================
        // REFUND ONLY FREE GENERATION
        // ==========================================

        if (!premiumActive) {

            // Refund the consumed generation directly in user_access.

            const { data: refundAccess, error: refundFetchError } =
                await supabaseClient
                    .from("user_access")
                    .select("generations_used")
                    .eq("user_id", session.user.id)
                    .maybeSingle();

            if (refundFetchError || !refundAccess) {

                console.error(
                    "Generation refund fetch failed:",
                    refundFetchError
                );

            } else {

                const currentUsed =
                    Number(refundAccess.generations_used || 0);

                const refundedUsed =
                    Math.max(0, currentUsed - 1);

                const { error: refundError } =
                    await supabaseClient
                        .from("user_access")
                        .update({
                            generations_used: refundedUsed
                        })
                        .eq("user_id", session.user.id);

                if (refundError) {

                    console.error(
                        "Generation refund failed:",
                        refundError
                    );

                }

            }

        }


        // Refresh counter from database

        if (window.refreshUsage) {

            await window.refreshUsage();

        }


        alert(
            premiumActive
                ? "We couldn't generate your QCAB. Please try again."
                : "We couldn't generate your QCAB. Your free generation has been restored. Please try again."
        );

    }

});



// ==========================================
// ANSWER PAGE CALCULATION
// ==========================================

function getAnswerPages(q) {

    const marks =
        Number(q.marks) || 0;

    if (marks === 15)
        return 3;

    if (marks >= 20)
        return 4;

    return 2;
}



// ==========================================
// ESCAPE HTML
// ==========================================

function escapePDFHTML(value) {

    return String(value || "")

        .replace(
            /&/g,
            "&amp;"
        )

        .replace(
            /</g,
            "&lt;"
        )

        .replace(
            />/g,
            "&gt;"
        )

        .replace(
            /"/g,
            "&quot;"
        )

        .replace(
            /'/g,
            "&#039;"
        );

}



// ==========================================
// CHECK RICH QUESTION
// ==========================================

function hasRichQuestion(q) {

    return !!q.question_html &&
        q.question_html.includes("<img");

}



// ==========================================
// WAIT FOR IMAGES
// ==========================================

function waitForImages(container) {

    const images =
        [...container.querySelectorAll("img")];

    return Promise.all(

        images.map(img => {

            if (
                img.complete &&
                img.naturalWidth > 0
            ) {

                return Promise.resolve();

            }

            return new Promise(resolve => {

                img.onload =
                    resolve;

                img.onerror =
                    resolve;

            });

        })

    );

}



// ==========================================
// RENDER QUESTION TO CANVAS
// ==========================================

async function renderQuestionToCanvas(
    q,
    widthPx = 1100
) {

    if (!window.html2canvas) {

        throw new Error(
            "html2canvas is not loaded. Please check your internet connection."
        );

    }

    const host =
        document.createElement("div");

    host.className =
        "pdf-question-render";

    host.style.cssText = [

        "position:fixed",

        "left:-100000px",

        "top:0",

        `width:${widthPx}px`,

        "padding:0",

        "margin:0",

        "background:#fff",

        "color:#111",

        "font-family:Times New Roman, serif",

        "font-size:30px",

        "line-height:1.45",

        "white-space:normal",

        "overflow:visible",

        "z-index:-1"

    ].join(";");

    host.innerHTML =
        q.question_html ||
        escapePDFHTML(
            q.question_text || ""
        );

    host.querySelectorAll("img")
        .forEach(img => {

            img.style.width =
                "100%";

            img.style.maxWidth =
                "100%";

            img.style.height =
                "auto";

            img.style.display =
                "block";

            img.style.margin =
                "3px 0";

        });

    document.body.appendChild(host);

    try {

        await waitForImages(
            host
        );

        return await window.html2canvas(

            host,

            {

                backgroundColor:
                    "#ffffff",

                scale:
                    2,

                useCORS:
                    true,

                logging:
                    false

            }

        );

    } finally {

        host.remove();

    }

}



// ==========================================
// ADD CANVAS IMAGE
// ==========================================

function addCanvasImage(

    doc,
    canvas,
    x,
    y,
    maxWidthMm,
    maxHeightMm = Infinity

) {

    let widthMm =
        maxWidthMm;

    let heightMm =
        widthMm *
        canvas.height /
        canvas.width;

    if (
        heightMm >
        maxHeightMm
    ) {

        const ratio =
            maxHeightMm /
            heightMm;

        widthMm *=
            ratio;

        heightMm =
            maxHeightMm;

    }

    const imageData =
        canvas.toDataURL(
            "image/png"
        );

    doc.addImage(

        imageData,

        "PNG",

        x,

        y,

        widthMm,

        heightMm,

        undefined,

        "FAST"

    );

    return {

        width:
            widthMm,

        height:
            heightMm

    };

}



// ==========================================
// GENERATE QCAB PDF
// ==========================================

async function generateQCABPDF(
    questions
) {

    const { jsPDF } =
        window.jspdf;

    const doc =
        new jsPDF({

            unit:
                "mm",

            format:
                "a4"

        });

    const pageHeight =
        297;

    const leftMargin =
        25;

    const rightMargin =
        185;

    const topMargin =
        15;

    const bottomMargin =
        282;

    doc.setFont(
        "Times",
        "Roman"
    );

    doc.setFontSize(
        12
    );


    // ==========================================
    // PART 1: QUESTION LISTING
    // ==========================================

    let currentY =
        topMargin;

    const localWidth =
        rightMargin -
        leftMargin +
        4;

    const lineHeight =
        6;


    for (
        const q of questions
    ) {

        if (
            hasRichQuestion(q)
        ) {

            try {

                const canvas =
                    await renderQuestionToCanvas(
                        q
                    );

                const imageHeight =
                    Math.min(

                        42,

                        localWidth *
                        canvas.height /
                        canvas.width

                    );

                const meta =
                    `[${q.marks} M${q.word_limit ? ` / ${q.word_limit} W` : ""}]`;

                const metaLines =
                    doc.splitTextToSize(

                        meta,

                        35

                    );

                const totalHeight =
                    Math.max(

                        imageHeight,

                        metaLines.length *
                        lineHeight

                    ) +
                    lineHeight;


                if (
                    currentY +
                    totalHeight >
                    pageHeight - 15
                ) {

                    doc.addPage();

                    currentY =
                        topMargin;

                }


                addCanvasImage(

                    doc,

                    canvas,

                    leftMargin + 2,

                    currentY,

                    localWidth,

                    42

                );

                doc.text(

                    `${q.question_number}.`,

                    leftMargin - 10,

                    currentY + 5

                );

                doc.setFontSize(
                    9
                );

                doc.text(

                    metaLines,

                    rightMargin + 2,

                    currentY + 5

                );

                doc.setFontSize(
                    12
                );

                currentY +=
                    totalHeight + 3;


            } catch (error) {

                console.error(

                    "Rich question rendering failed:",

                    error

                );

                const fallback =
                    `${q.question_text || ""}   [${q.marks} M${q.word_limit ? ` / ${q.word_limit} W` : ""}]`;

                const splitText =
                    doc.splitTextToSize(

                        fallback,

                        localWidth

                    );

                const totalHeight =
                    splitText.length *
                    lineHeight +
                    lineHeight;


                if (
                    currentY +
                    totalHeight >
                    pageHeight - 15
                ) {

                    doc.addPage();

                    currentY =
                        topMargin;

                }

                doc.text(

                    `${q.question_number}.`,

                    leftMargin - 10,

                    currentY

                );

                doc.text(

                    splitText,

                    leftMargin + 2,

                    currentY

                );

                currentY +=
                    totalHeight;

            }

        } else {

            const qText =
                `${q.question_text || ""}   [${q.marks} M${q.word_limit ? ` / ${q.word_limit} W` : ""}]`;

            const splitText =
                doc.splitTextToSize(

                    qText,

                    localWidth

                );

            const totalHeight =
                splitText.length *
                lineHeight +
                lineHeight;


            if (
                currentY +
                totalHeight >
                pageHeight - 15
            ) {

                doc.addPage();

                currentY =
                    topMargin;

            }

            doc.text(

                `${q.question_number}.`,

                leftMargin - 10,

                currentY

            );

            doc.text(

                splitText,

                leftMargin + 2,

                currentY

            );

            currentY +=
                totalHeight;

        }

    }


    // ==========================================
    // FIRST PAGE FOOTER
    // ==========================================

    doc.setFontSize(
        9
    );

    doc.text(

        "Made by DoomsDay QCAB Generator - for more info contact : cds2gc@gmail.com",

        105,

        288,

        {

            align:
                "center"

        }

    );

    doc.setFontSize(
        22
    );


    // ==========================================
    // PART 2: QCAB ANSWER PAGES
    // ==========================================

    for (
        const q of questions
    ) {

        const pagesNeeded =
            getAnswerPages(q);


        for (
            let p = 0;
            p < pagesNeeded;
            p++
        ) {

            doc.addPage();

            doc.setLineWidth(
                0.3
            );

            doc.line(

                leftMargin,

                topMargin,

                leftMargin,

                bottomMargin

            );

            doc.line(

                rightMargin,

                topMargin,

                rightMargin,

                bottomMargin

            );


            const footerText =
                `XXXX-CUSTOM_${q.question_number}`;

            doc.setFontSize(
                8
            );

            doc.text(

                footerText,

                leftMargin - 10,

                bottomMargin + 3

            );


            // ==========================================
            // FIRST ANSWER PAGE
            // ==========================================

            if (
                p === 0
            ) {

                doc.setFontSize(
                    12
                );

                doc.text(

                    `Q. ${q.question_number}`,

                    leftMargin - 15,

                    topMargin + 5

                );


                const localQuestionWidth =
                    rightMargin -
                    leftMargin -
                    4;

                let questionBottom =
                    topMargin + 5;


                if (
                    hasRichQuestion(q)
                ) {

                    try {

                        const canvas =
                            await renderQuestionToCanvas(
                                q
                            );

                        const image =
                            addCanvasImage(

                                doc,

                                canvas,

                                leftMargin + 2,

                                topMargin,

                                localQuestionWidth,

                                55

                            );

                        questionBottom =
                            topMargin +
                            14 +
                            image.height;


                    } catch (error) {

                        console.error(

                            "Rich question rendering failed:",

                            error

                        );

                        const splitText =
                            doc.splitTextToSize(

                                q.question_text || "",

                                localQuestionWidth

                            );

                        doc.setFontSize(
                            12
                        );

                        doc.text(

                            splitText,

                            leftMargin + 2,

                            topMargin + 5

                        );

                        questionBottom =
                            topMargin +
                            5 +
                            splitText.length * 6;

                    }

                } else {

                    const splitText =
                        doc.splitTextToSize(

                            `${q.question_text || ""}`,

                            localQuestionWidth

                        );

                    doc.setFontSize(
                        12
                    );

                    doc.text(

                        splitText,

                        leftMargin + 2,

                        topMargin + 5

                    );

                    questionBottom =
                        topMargin +
                        5 +
                        splitText.length * 6;

                }


                // ==========================================
                // MARKS
                // ==========================================

                doc.setFontSize(
                    12
                );

                const metadata = [

                    q.marks != null
                        ? `${q.marks} M`
                        : ""

                ]

                    .filter(Boolean)

                    .join(" / ");


                doc.text(

                    metadata,

                    rightMargin + 2,

                    topMargin + 5

                );


                // ==========================================
                // ANSWER-WRITING AREA
                // ==========================================

                if (
                    questionBottom <
                    bottomMargin - 4
                ) {

                    doc.setFontSize(
                        8
                    );

                    doc.setTextColor(

                        110,

                        110,

                        110

                    );

                    doc.setTextColor(

                        0,

                        0,

                        0

                    );

                }


            } else {

                // ==========================================
                // ORIGINAL MARGIN MESSAGE POSITION
                // ==========================================

                const localWidth =
                    23;

                const splitText =
                    doc.splitTextToSize(

                        "Candidates must not write on this margin",

                        localWidth

                    );

                doc.setFontSize(
                    8
                );

                doc.text(

                    splitText,

                    rightMargin + 2,

                    topMargin + 5

                );

            }

        }

    }


    // ==========================================
    // SAVE PDF
    // ==========================================

    window.generatedPDF =
        doc;

    doc.save(
        "QCAB.pdf"
    );

}
