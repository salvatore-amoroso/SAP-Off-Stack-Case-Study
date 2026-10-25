CLASS zcl_bl_bench_orders DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
  INTERFACES if_oo_adt_classrun.
 PRIVATE SECTION.
  CONSTANTS service_root TYPE string VALUE
    'http://host.docker.internal/sap/opu/odata4/sap/zui_bl_orders_o4/srvd_a2x/sap/zui_bl_orders/0001/'.
  TYPES: BEGIN OF ty_input,
    username TYPE string,
    password TYPE string,
    service_root TYPE string,
    sap_client TYPE string,
    expected_rows TYPE i,
    expected_digest TYPE string,
    scans TYPE i,
    interval_ms TYPE i,
    request_timeout_seconds TYPE i,
    scan_timeout_seconds TYPE i,
    page_size TYPE i,
    max_body_bytes TYPE i,
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
    authentication TYPE string,
    service_root TYPE string,
    duration_seconds TYPE i,
    warmup_scans TYPE i,
    measured_scans TYPE i,
    measured_wall_ms TYPE int8,
    measured_valid_rows TYPE int8,
    measured_body_bytes TYPE int8,
    failed_scans TYPE i,
  END OF ty_summary.
  DATA timer TYPE REF TO if_abap_runtime.
  DATA previous TYPE i.
  DATA accumulated TYPE int8.
  METHODS now RETURNING VALUE(microseconds) TYPE int8.
  CLASS-METHODS invalid.
ENDCLASS.

CLASS zcl_bl_bench_orders IMPLEMENTATION.
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
  DATA(summary) = VALUE ty_summary( kind = 'summary' transport = 'classic_socket'
    authentication = 'preemptive_basic' service_root = service_root ).
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
    DATA has_root TYPE abap_bool.
    DATA has_rows TYPE abap_bool.
    DATA has_digest TYPE abap_bool.
    DO.
      node = reader->next_node( ).
      IF node-type = if_json_node=>close_object. EXIT. ENDIF.
      FIELD-SYMBOLS <field> TYPE any.
      ASSIGN COMPONENT to_upper( node-name ) OF STRUCTURE input TO <field>.
      IF sy-subrc <> 0. invalid( ). ENDIF.
      IF node-name = 'username' OR node-name = 'password' OR node-name = 'service_root'
        OR node-name = 'sap_client' OR node-name = 'expected_digest'.
        IF node-type <> if_json_node=>string. invalid( ). ENDIF.
        <field> = node-value.
      ELSE.
        IF node-type <> if_json_node=>number OR NOT matches( val = node-value pcre = '^-?[0-9]+\z' ).
          invalid( ).
        ENDIF.
        <field> = CONV i( node-value ).
      ENDIF.
      CASE node-name.
        WHEN 'service_root'. has_root = abap_true.
        WHEN 'expected_rows'. has_rows = abap_true.
        WHEN 'expected_digest'. has_digest = abap_true.
      ENDCASE.
    ENDDO.
    node = reader->next_node( ).
    IF node-type <> if_json_node=>final OR has_root = abap_false OR has_rows = abap_false
      OR has_digest = abap_false OR input-username IS INITIAL OR input-password IS INITIAL
      OR to_upper( input-username ) <> sy-uname OR sy-mandt <> '001'
      OR input-service_root <> service_root OR input-sap_client <> '001'
      OR input-duration_seconds < 1 OR input-duration_seconds > 600
      OR input-warmup_scans < 0 OR input-warmup_scans > 100
      OR input-max_scans < 0 OR input-max_scans > 1000000 OR input-scans <> 1.
      invalid( ).
    ENDIF.
    DATA(config) = CORRESPONDING zcl_bl_poll_orders=>ty_config( input ).
    " Establish preemptive Basic request state without sending or exposing a header.
    DATA auth_client TYPE REF TO if_http_client.
    cl_http_client=>create_by_url( EXPORTING url = 'http://host.docker.internal'
      IMPORTING client = auth_client EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc <> 0 OR auth_client IS NOT BOUND. invalid( ). ENDIF.
    auth_client->authenticate( username = input-username password = CONV #( input-password ) ).
    auth_client->request->get_authorization(
      IMPORTING auth_type = DATA(auth_type) username = DATA(auth_user) password = DATA(auth_password) ).
    DATA(auth_ok) = xsdbool( auth_type = 1 AND auth_user = input-username AND auth_password = input-password ).
    auth_client->close( EXCEPTIONS OTHERS = 1 ).
    CLEAR: auth_user, auth_password, auth_client.
    IF auth_ok = abap_false. invalid( ). ENDIF.
    CLEAR: body, node, reader.
    timer = cl_abap_runtime=>create_hr_timer( ).
    previous = timer->get_runtime( ).
    CLEAR accumulated.
    DATA(poller) = NEW zcl_bl_poll_orders( ).
    DO input-warmup_scans TIMES.
      DATA(scan_started) = now( ).
      DATA(result) = poller->scan( config = config username = input-username
        password = input-password scan_index = sy-index - 1 ).
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
        result = poller->scan( config = config username = input-username
          password = input-password scan_index = summary-measured_scans ).
        result-elapsed_ms = ( now( ) - scan_started ) DIV 1000.
        APPEND VALUE #( phase = 'measured' result = result ) TO records.
        summary-measured_scans += 1.
        summary-measured_body_bytes += result-body_bytes.
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
    CLEAR: input-username, input-password.
    " Serialize only after the measurement window, without input/authentication data.
    LOOP AT records INTO DATA(record).
      DATA(json) = zcl_bl_poll_orders=>to_json( record-result ).
      out->write( '{"kind":"scan","phase":"' && record-phase && '",' && json+1 ).
    ENDLOOP.
    out->write( /ui2/cl_json=>serialize( data = summary pretty_name = /ui2/cl_json=>pretty_mode-low_case ) ).
  CATCH cx_root.
    out->write( '{"kind":"error","code":"CONFIG"}' ).
  ENDTRY.
 ENDMETHOD.
ENDCLASS.
