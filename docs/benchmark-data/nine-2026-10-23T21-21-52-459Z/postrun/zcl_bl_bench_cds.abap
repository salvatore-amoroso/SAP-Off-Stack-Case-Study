CLASS zcl_bl_bench_cds DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
  INTERFACES if_oo_adt_classrun.
 PRIVATE SECTION.
  TYPES: BEGIN OF ty_input,
    sap_client TYPE string,
    expected_rows TYPE i,
    expected_digest TYPE string,
    scan_timeout_seconds TYPE i,
    max_pages TYPE i,
    duration_seconds TYPE i,
    warmup_scans TYPE i,
    max_scans TYPE i,
  END OF ty_input.
  TYPES: BEGIN OF ty_record,
    phase TYPE string,
    result TYPE zcl_bl_poll_orders=>ty_result,
  END OF ty_record.
  TYPES: BEGIN OF ty_summary,
    kind TYPE string,
    transport TYPE string,
    entity TYPE string,
    sap_client TYPE string,
    db_package_size TYPE i,
    http_requests TYPE i,
    duration_seconds TYPE i,
    warmup_scans TYPE i,
    measured_scans TYPE i,
    measured_wall_ms TYPE int8,
    measured_valid_rows TYPE int8,
    measured_application_batches TYPE int8,
    measured_body_bytes TYPE int8,
    failed_scans TYPE i,
  END OF ty_summary.
  DATA timer TYPE REF TO if_abap_runtime.
  DATA previous TYPE i.
  DATA accumulated TYPE int8.
  METHODS now RETURNING VALUE(microseconds) TYPE int8.
  CLASS-METHODS invalid.
ENDCLASS.

CLASS zcl_bl_bench_cds IMPLEMENTATION.
 METHOD invalid.
  RAISE EXCEPTION TYPE cx_sy_conversion_no_number.
 ENDMETHOD.
 METHOD now.
  DATA(current) = timer->get_runtime( ).
  DATA(delta) = CONV int8( current ) - previous.
  IF delta < 0. delta += 4294967296. ENDIF.
  accumulated += delta.
  previous = current.
  microseconds = accumulated.
 ENDMETHOD.
 METHOD if_oo_adt_classrun~main.
  DATA records TYPE STANDARD TABLE OF ty_record WITH EMPTY KEY.
  DATA(summary) = VALUE ty_summary( kind = 'summary' transport = 'direct_cds'
    entity = 'ZI_BL_OrderPosition' sap_client = sy-mandt db_package_size = 100 ).
  TRY.
    DATA server TYPE REF TO if_http_server.
    CALL FUNCTION 'HTTP_GET_CURRENT_SERVER_CB'
      IMPORTING server_cb = server EXCEPTIONS no_icf_session = 1 OTHERS = 2.
    IF sy-subrc <> 0 OR server IS NOT BOUND. invalid( ). ENDIF.
    DATA(body) = server->request->get_cdata( ).
    IF body IS INITIAL. invalid( ). ENDIF.
    DATA(input) = CORRESPONDING ty_input( zcl_bl_poll_orders=>defaults( ) ).
    input-duration_seconds = 180.
    input-warmup_scans = 5.
    DATA(reader) = cl_json_string_reader=>create( body ).
    DATA(node) = reader->next_node( ).
    IF node-type <> if_json_node=>open_object. invalid( ). ENDIF.
    DATA has_rows TYPE abap_bool.
    DATA has_digest TYPE abap_bool.
    DO.
      node = reader->next_node( ).
      IF node-type = if_json_node=>close_object. EXIT. ENDIF.
      FIELD-SYMBOLS <field> TYPE any.
      ASSIGN COMPONENT to_upper( node-name ) OF STRUCTURE input TO <field>.
      IF sy-subrc <> 0. invalid( ). ENDIF.
      IF node-name = 'sap_client' OR node-name = 'expected_digest'.
        IF node-type <> if_json_node=>string. invalid( ). ENDIF.
        <field> = node-value.
      ELSE.
        IF node-type <> if_json_node=>number OR NOT matches( val = node-value pcre = '^-?[0-9]+\z' ).
          invalid( ).
        ENDIF.
        <field> = CONV i( node-value ).
      ENDIF.
      CASE node-name.
        WHEN 'expected_rows'. has_rows = abap_true.
        WHEN 'expected_digest'. has_digest = abap_true.
      ENDCASE.
    ENDDO.
    node = reader->next_node( ).
    IF node-type <> if_json_node=>final OR has_rows = abap_false OR has_digest = abap_false
      OR sy-mandt <> '001' OR input-sap_client <> sy-mandt
      OR input-duration_seconds < 1 OR input-duration_seconds > 600
      OR input-warmup_scans < 0 OR input-warmup_scans > 100
      OR input-max_scans < 0 OR input-max_scans > 1000000.
      invalid( ).
    ENDIF.
    DATA(config) = zcl_bl_poll_orders=>defaults( ).
    MOVE-CORRESPONDING input TO config.
    CLEAR: body, node, reader.
    timer = cl_abap_runtime=>create_hr_timer( ).
    previous = timer->get_runtime( ).
    CLEAR accumulated.
    DATA(poller) = NEW zcl_bl_poll_orders( ).
    DO input-warmup_scans TIMES.
      DATA(scan_started) = now( ).
      DATA(result) = poller->scan_cds( config = config scan_index = sy-index - 1 ).
      result-elapsed_ms = ( now( ) - scan_started ) DIV 1000.
      APPEND VALUE #( phase = 'warmup' result = result ) TO records.
      summary-warmup_scans += 1.
      IF result-outcome <> 'ok'.
        summary-failed_scans += 1.
        EXIT.
      ENDIF.
    ENDDO.
    DATA(measured_origin) = now( ).
    IF summary-failed_scans = 0.
      DO.
        IF now( ) - measured_origin >= CONV int8( input-duration_seconds ) * 1000000
          OR ( input-max_scans > 0 AND summary-measured_scans >= input-max_scans ).
          EXIT.
        ENDIF.
        scan_started = now( ).
        result = poller->scan_cds( config = config scan_index = summary-measured_scans ).
        result-elapsed_ms = ( now( ) - scan_started ) DIV 1000.
        APPEND VALUE #( phase = 'measured' result = result ) TO records.
        summary-measured_scans += 1.
        summary-measured_application_batches += result-pages.
        IF result-outcome = 'ok'.
          summary-measured_valid_rows += result-rows.
        ELSE.
          summary-failed_scans += 1.
          EXIT.
        ENDIF.
      ENDDO.
    ENDIF.
    summary-measured_wall_ms = ( now( ) - measured_origin ) DIV 1000.
    summary-duration_seconds = input-duration_seconds.
    " No row JSON is created in the measured path; only result records serialize here.
    LOOP AT records INTO DATA(record).
      DATA(json) = zcl_bl_poll_orders=>to_json( record-result ).
      out->write( '{"kind":"scan","phase":"' && record-phase
        && '","transport":"direct_cds","application_batches":' && |{ record-result-pages NUMBER = RAW }|
        && ',"http_requests":0,' && json+1 ).
    ENDLOOP.
    out->write( /ui2/cl_json=>serialize( data = summary pretty_name = /ui2/cl_json=>pretty_mode-low_case ) ).
  CATCH cx_root.
    out->write( '{"kind":"error","code":"CONFIG"}' ).
  ENDTRY.
 ENDMETHOD.
ENDCLASS.
