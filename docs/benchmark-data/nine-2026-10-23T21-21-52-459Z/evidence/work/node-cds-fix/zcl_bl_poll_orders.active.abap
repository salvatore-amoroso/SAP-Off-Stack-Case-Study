CLASS zcl_bl_poll_orders DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_config,
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
    END OF ty_config.
    TYPES: BEGIN OF ty_page,
      status TYPE i,
      url TYPE string,
      body_json TYPE string,
      body_raw TYPE xstring,
    END OF ty_page,
    tt_pages TYPE STANDARD TABLE OF ty_page WITH EMPTY KEY.
    TYPES: BEGIN OF ty_error,
      code TYPE string,
      page_index TYPE i,
      http_status TYPE i,
    END OF ty_error.
    TYPES: BEGIN OF ty_result,
      schema_version TYPE i,
      scan_index TYPE i,
      outcome TYPE string,
      rows TYPE i,
      pages TYPE i,
      digest TYPE string,
      error TYPE ty_error,
      elapsed_ms TYPE int8,
      body_bytes TYPE int8,
      missed_slots TYPE i,
    END OF ty_result,
    tt_results TYPE STANDARD TABLE OF ty_result WITH EMPTY KEY.
    CLASS-METHODS defaults RETURNING VALUE(config) TYPE ty_config.
    METHODS scan IMPORTING config TYPE ty_config pages TYPE tt_pages OPTIONAL
      destination TYPE rfcdest OPTIONAL username TYPE string OPTIONAL
      password TYPE string OPTIONAL internal TYPE abap_bool DEFAULT abap_false
      scan_index TYPE i DEFAULT 0 RETURNING VALUE(result) TYPE ty_result.
    METHODS scan_cds IMPORTING config TYPE ty_config scan_index TYPE i DEFAULT 0
      RETURNING VALUE(result) TYPE ty_result.
    METHODS fixture IMPORTING config_json TYPE string pages TYPE tt_pages
      RETURNING VALUE(result) TYPE ty_result.
    METHODS run IMPORTING config TYPE ty_config destination TYPE rfcdest OPTIONAL
      username TYPE string OPTIONAL password TYPE string OPTIONAL
      internal TYPE abap_bool DEFAULT abap_false RETURNING VALUE(results) TYPE tt_results.
    CLASS-METHODS to_json IMPORTING result TYPE ty_result RETURNING VALUE(json) TYPE string.
    METHODS scan_native IMPORTING config TYPE ty_config scan_index TYPE i DEFAULT 0
      RETURNING VALUE(result) TYPE ty_result.
  PRIVATE SECTION.
    TYPES tt_nodes TYPE STANDARD TABLE OF if_json_node=>node WITH EMPTY KEY.
    TYPES: BEGIN OF ty_url,
      origin TYPE string,
      path TYPE string,
      query TYPE string,
      absolute TYPE string,
    END OF ty_url.
    DATA settings TYPE ty_config.
    DATA current_result TYPE ty_result.
    DATA nodes TYPE tt_nodes.
    DATA previous_order TYPE string.
    DATA previous_position TYPE string.
    DATA digest TYPE REF TO cl_abap_message_digest.
    DATA timer TYPE REF TO lcl_bl_clock.
    DATA started TYPE int8.
    DATA client TYPE REF TO if_http_client.
    DATA root TYPE ty_url.
    CLASS-METHODS fail IMPORTING code TYPE string RAISING lcx_bl_poll.
    CLASS-METHODS parse_url IMPORTING value TYPE string RETURNING VALUE(url) TYPE ty_url RAISING lcx_bl_poll.
    CLASS-METHODS path_normalize IMPORTING value TYPE string RETURNING VALUE(path) TYPE string RAISING lcx_bl_poll.
    METHODS config_check IMPORTING direct TYPE abap_bool DEFAULT abap_false RAISING lcx_bl_poll.
    METHODS deadline RAISING lcx_bl_poll.
    METHODS page_read IMPORTING url TYPE string destination TYPE rfcdest username TYPE string
      password TYPE string internal TYPE abap_bool RETURNING VALUE(page) TYPE ty_page RAISING lcx_bl_poll.
    METHODS process_page IMPORTING raw TYPE xstring RETURNING VALUE(next_link) TYPE string RAISING lcx_bl_poll.
    METHODS skip_node IMPORTING position TYPE i RETURNING VALUE(after) TYPE i RAISING lcx_bl_poll.
    METHODS process_row IMPORTING position TYPE i RETURNING VALUE(after) TYPE i RAISING lcx_bl_poll.
    METHODS validate_values IMPORTING VALUE(values) TYPE string_table RAISING lcx_bl_poll.
    CLASS-METHODS decimal IMPORTING value TYPE string scale TYPE i digits TYPE i
      RETURNING VALUE(normalized) TYPE string RAISING lcx_bl_poll.
    METHODS continuation IMPORTING value TYPE string current TYPE string RETURNING VALUE(url) TYPE string RAISING lcx_bl_poll.
ENDCLASS.

CLASS zcl_bl_poll_orders IMPLEMENTATION.
  METHOD defaults.
    config = VALUE #( sap_client = '001' scans = 1 interval_ms = 1000
      request_timeout_seconds = 10 scan_timeout_seconds = 120 page_size = 500
      max_body_bytes = 8388608 max_pages = 10000 ).
  ENDMETHOD.

  METHOD fail.
    RAISE EXCEPTION TYPE lcx_bl_poll EXPORTING code = code.
  ENDMETHOD.

  METHOD path_normalize.
    IF value CS '\' OR contains( val = value pcre = '[[:cntrl:]]' )
      OR contains( val = value pcre = '(?i)%(2f|5c)' ).
      fail( 'NEXTLINK' ).
    ENDIF.
    DATA parts TYPE string_table.
    DATA stack TYPE string_table.
    SPLIT value AT '/' INTO TABLE parts.
    LOOP AT parts INTO DATA(part).
      IF sy-tabix = 1 AND part IS INITIAL.
        CONTINUE.
      ENDIF.
      IF contains( val = part pcre = '(?i)%2e' )
        AND matches( val = part pcre = '(?i)^(?:\.|%2e){1,2}\z' ).
        fail( 'NEXTLINK' ).
      ENDIF.
      IF part = '.'.
        CONTINUE.
      ELSEIF part = '..'.
        IF lines( stack ) > 0.
          DELETE stack INDEX lines( stack ).
        ENDIF.
      ELSE.
        APPEND part TO stack.
      ENDIF.
    ENDLOOP.
    path = '/' && concat_lines_of( table = stack sep = '/' ).
    IF ( value CP '*/' OR value CP '*/.' OR value CP '*/..' ) AND path NP '*/'.
      path &&= '/'.
    ENDIF.
  ENDMETHOD.

  METHOD parse_url.
    IF value IS INITIAL OR value CS '#' OR value CS '\'
      OR contains( val = value pcre = '[^\x21-\x7e]' ).
      fail( 'NEXTLINK' ).
    ENDIF.
    DATA scheme TYPE string.
    DATA authority TYPE string.
    DATA raw_path TYPE string.
    DATA host TYPE string.
    DATA port_text TYPE string.
    FIND PCRE '(?i)^(https?)://([^/?#]+)(/[^?#]*)?(\?[^#]*)?$' IN value
      SUBMATCHES scheme authority raw_path url-query.
    IF sy-subrc <> 0 OR authority CS '@'.
      fail( 'NEXTLINK' ).
    ENDIF.
    FIND PCRE '^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:([0-9]+))?$' IN authority
      SUBMATCHES host DATA(port_separator) port_text.
    IF sy-subrc <> 0.
      fail( 'NEXTLINK' ).
    ENDIF.
    TRANSLATE host TO LOWER CASE.
    TRANSLATE scheme TO LOWER CASE.
    IF port_text IS NOT INITIAL.
      TRY.
          DATA(port) = CONV i( port_text ).
        CATCH cx_root.
          fail( 'NEXTLINK' ).
      ENDTRY.
      IF port < 1 OR port > 65535.
        fail( 'NEXTLINK' ).
      ENDIF.
      IF ( scheme = 'http' AND port = 80 ) OR ( scheme = 'https' AND port = 443 ).
        CLEAR port_text.
      ELSE.
        port_text = |:{ port NUMBER = RAW }|.
      ENDIF.
    ENDIF.
    url-origin = scheme && '://' && host && port_text.
    url-path = path_normalize( raw_path ).
    url-absolute = url-origin && url-path && url-query.
  ENDMETHOD.

  METHOD config_check.
    IF settings-expected_rows < 0 OR settings-scans < 1 OR settings-scans > 1000000
      OR settings-interval_ms < 1 OR settings-interval_ms > 3600000
      OR settings-request_timeout_seconds < 1 OR settings-request_timeout_seconds > 3600
      OR settings-scan_timeout_seconds < 1 OR settings-scan_timeout_seconds > 86400
      OR settings-page_size < 1 OR settings-page_size > 10000
      OR settings-max_body_bytes < 1 OR settings-max_body_bytes > 67108864
      OR settings-max_pages < 1 OR settings-max_pages > 1000000
      OR NOT matches( val = settings-sap_client pcre = '^[0-9]{3}$' )
      OR NOT matches( val = settings-expected_digest pcre = '^[0-9a-f]{64}$' ).
      fail( 'CONFIG' ).
    ENDIF.
    IF direct = abap_true.
      IF settings-sap_client <> sy-mandt.
        fail( 'CONFIG' ).
      ENDIF.
      RETURN.
    ENDIF.
    TRY.
        root = parse_url( settings-service_root ).
      CATCH lcx_bl_poll.
        fail( 'CONFIG' ).
    ENDTRY.
    IF root-query IS NOT INITIAL OR root-path NP '*/'.
      fail( 'CONFIG' ).
    ENDIF.
  ENDMETHOD.

  METHOD deadline.
    IF timer->now( ) - started >= CONV int8( settings-scan_timeout_seconds ) * 1000000.
      fail( 'TIMEOUT' ).
    ENDIF.
  ENDMETHOD.

  METHOD decimal.
    IF NOT matches( val = value pcre = '^[0-9]+(\.[0-9]+)?$' ).
      fail( 'SCHEMA' ).
    ENDIF.
    SPLIT value AT '.' INTO DATA(integer) DATA(fraction).
    SHIFT integer LEFT DELETING LEADING '0'.
    IF integer IS INITIAL.
      integer = '0'.
    ENDIF.
    IF strlen( integer ) > digits OR strlen( fraction ) > scale.
      fail( 'SCHEMA' ).
    ENDIF.
    WHILE strlen( fraction ) < scale.
      fraction &&= '0'.
    ENDWHILE.
    normalized = integer && '.' && fraction.
  ENDMETHOD.

  METHOD skip_node.
    IF position < 1 OR position > lines( nodes ).
      fail( 'SCHEMA' ).
    ENDIF.
    after = position + 1.
    DATA(depth) = 0.
    IF nodes[ position ]-type = if_json_node=>open_array
      OR nodes[ position ]-type = if_json_node=>open_object.
      depth = 1.
      WHILE depth > 0 AND after <= lines( nodes ).
        CASE nodes[ after ]-type.
          WHEN if_json_node=>open_array OR if_json_node=>open_object. depth += 1.
          WHEN if_json_node=>close_array OR if_json_node=>close_object. depth -= 1.
        ENDCASE.
        after += 1.
      ENDWHILE.
      IF depth <> 0.
        fail( 'SCHEMA' ).
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD process_row.
    IF nodes[ position ]-type <> if_json_node=>open_object.
      fail( 'SCHEMA' ).
    ENDIF.
    DATA values TYPE string_table.
    DO 9 TIMES.
      APPEND `` TO values.
    ENDDO.
    DATA names TYPE string_table.
    SPLIT 'OrderId,PositionNumber,CustomerId,OrderDate,MaterialId,Quantity,Unit,NetAmount,Currency' AT ',' INTO TABLE names.
    DATA(index) = position + 1.
    WHILE index <= lines( nodes ) AND nodes[ index ]-type <> if_json_node=>close_object.
      DATA(node) = nodes[ index ].
      READ TABLE names WITH KEY table_line = node-name TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        DATA(field_index) = sy-tabix.
        IF node-type <> if_json_node=>string.
          fail( 'SCHEMA' ).
        ENDIF.
        values[ field_index ] = node-value.
      ENDIF.
      index = skip_node( index ).
    ENDWHILE.
    IF index > lines( nodes ).
      fail( 'SCHEMA' ).
    ENDIF.
    validate_values( values ).
    after = index + 1.
  ENDMETHOD.

  METHOD validate_values.
    IF lines( values ) <> 9.
      fail( 'SCHEMA' ).
    ENDIF.
    IF NOT matches( val = values[ 1 ] pcre = '^[A-Za-z0-9_-]{1,20}$' )
      OR NOT matches( val = values[ 2 ] pcre = '^[0-9]{6}$' )
      OR NOT matches( val = values[ 3 ] pcre = '^[A-Za-z0-9_-]{1,10}$' )
      OR NOT matches( val = values[ 4 ] pcre = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' )
      OR NOT matches( val = values[ 5 ] pcre = '^[A-Za-z0-9_-]{1,18}$' )
      OR NOT matches( val = values[ 7 ] pcre = '^[A-Z]{1,3}$' )
      OR NOT matches( val = values[ 9 ] pcre = '^[A-Z]{3}$' ).
      fail( 'SCHEMA' ).
    ENDIF.
    DATA(date_text) = replace( val = values[ 4 ] sub = '-' with = '' occ = 0 ).
    DATA(date) = CONV d( date_text ).
    CALL FUNCTION 'DATE_CHECK_PLAUSIBILITY' EXPORTING date = date EXCEPTIONS OTHERS = 1.
    IF sy-subrc <> 0 OR date_text(4) = '0000'.
      fail( 'SCHEMA' ).
    ENDIF.
    values[ 6 ] = decimal( value = values[ 6 ] scale = 3 digits = 10 ).
    values[ 8 ] = decimal( value = values[ 8 ] scale = 2 digits = 13 ).
    IF current_result-rows > 0 AND ( values[ 1 ] < previous_order
      OR ( values[ 1 ] = previous_order AND values[ 2 ] <= previous_position ) ).
      fail( 'ORDER' ).
    ENDIF.
    DATA(line) = concat_lines_of( table = values sep = cl_abap_char_utilities=>horizontal_tab )
      && cl_abap_char_utilities=>newline.
    TRY.
        digest->update( cl_abap_message_digest=>string_to_xstring( line ) ).
      CATCH cx_abap_message_digest.
        fail( 'SCHEMA' ).
    ENDTRY.
    previous_order = values[ 1 ].
    previous_position = values[ 2 ].
    current_result-rows += 1.
  ENDMETHOD.

  METHOD process_page.
    CLEAR nodes.
    TRY.
        DATA text TYPE string.
        DATA incomplete TYPE abap_bool.
        DATA(decoder) = cl_abap_conv_in_ce=>create( encoding = 'UTF-8' ignore_cerr = abap_false ).
        decoder->convert( EXPORTING input = raw IMPORTING data = text input_too_short = incomplete ).
        IF incomplete = abap_true.
          fail( 'SCHEMA' ).
        ENDIF.
        DATA(reader) = cl_json_string_reader=>create( text ).
        DO.
          DATA(node) = reader->next_node( ).
          IF node-type = if_json_node=>final.
            EXIT.
          ENDIF.
          APPEND node TO nodes.
        ENDDO.
      CATCH cx_root.
        fail( 'SCHEMA' ).
    ENDTRY.
    IF lines( nodes ) < 2 OR nodes[ 1 ]-type <> if_json_node=>open_object.
      fail( 'SCHEMA' ).
    ENDIF.
    DATA(value_index) = 0.
    DATA(next_present) = abap_false.
    DATA(index) = 2.
    WHILE index <= lines( nodes ) AND nodes[ index ]-type <> if_json_node=>close_object.
      node = nodes[ index ].
      IF node-name = 'value'.
        IF node-type <> if_json_node=>open_array.
          fail( 'SCHEMA' ).
        ENDIF.
        value_index = index.
      ELSEIF node-name = '@odata.nextLink'.
        IF node-type <> if_json_node=>string.
          fail( 'SCHEMA' ).
        ENDIF.
        next_present = abap_true.
        next_link = node-value.
      ENDIF.
      index = skip_node( index ).
    ENDWHILE.
    IF value_index = 0 OR index <> lines( nodes ).
      fail( 'SCHEMA' ).
    ENDIF.
    index = value_index + 1.
    WHILE index <= lines( nodes ) AND nodes[ index ]-type <> if_json_node=>close_array.
      deadline( ).
      index = process_row( index ).
    ENDWHILE.
    IF next_present = abap_true AND next_link IS INITIAL.
      fail( 'NEXTLINK' ).
    ENDIF.
    CLEAR nodes.
  ENDMETHOD.

  METHOD continuation.
    IF value IS INITIAL OR value CS '#' OR value CS '\' OR value CP '//*'
      OR contains( val = value pcre = '[^\x21-\x7e]' ).
      fail( 'NEXTLINK' ).
    ENDIF.
    DATA(base) = parse_url( current ).
    DATA(candidate) = value.
    IF contains( val = value pcre = '^[A-Za-z][A-Za-z0-9+.-]*:' ).
    ELSEIF value(1) = '/'.
      candidate = base-origin && value.
    ELSEIF value(1) = '?'.
      candidate = base-origin && base-path && value.
    ELSE.
      DATA(directory) = replace( val = base-path pcre = '[^/]*$' with = '' ).
      candidate = base-origin && directory && value.
    ENDIF.
    DATA(parsed) = parse_url( candidate ).
    IF parsed-origin <> root-origin OR strlen( parsed-path ) < strlen( root-path ).
      fail( 'NEXTLINK' ).
    ENDIF.
    DATA(root_length) = strlen( root-path ).
    IF parsed-path(root_length) <> root-path.
      fail( 'NEXTLINK' ).
    ENDIF.
    DATA(query) = parsed-query.
    IF query IS NOT INITIAL.
      query = query+1.
      DATA pairs TYPE string_table.
      SPLIT query AT '&' INTO TABLE pairs.
      LOOP AT pairs INTO DATA(pair).
        SPLIT pair AT '=' INTO DATA(name) DATA(client_value).
        name = cl_http_utility=>unescape_url( name ).
        client_value = cl_http_utility=>unescape_url( client_value ).
        IF name = 'sap-client' AND client_value <> settings-sap_client.
          fail( 'NEXTLINK' ).
        ENDIF.
      ENDLOOP.
    ENDIF.
    url = parsed-absolute.
  ENDMETHOD.

  METHOD page_read.
    DATA(parsed) = parse_url( url ).
    IF client IS NOT BOUND.
      IF internal = abap_true.
        cl_http_client=>create_internal( IMPORTING client = client EXCEPTIONS OTHERS = 1 ).
      ELSEIF destination IS NOT INITIAL.
        cl_http_client=>create_by_destination( EXPORTING destination = destination IMPORTING client = client EXCEPTIONS OTHERS = 1 ).
      ELSE.
        cl_http_client=>create_by_url( EXPORTING url = parsed-origin IMPORTING client = client EXCEPTIONS OTHERS = 1 ).
      ENDIF.
      IF sy-subrc <> 0 OR client IS NOT BOUND.
        fail( 'TRANSPORT' ).
      ENDIF.
      client->propertytype_logon_popup = if_http_client=>co_disabled.
      client->propertytype_redirect = if_http_client=>co_disabled.
      client->propertytype_accept_cookie = if_http_client=>co_disabled.
      client->propertytype_accept_compress = if_http_client=>co_disabled.
      IF username IS NOT INITIAL.
        client->authenticate( username = username password = CONV #( password ) ).
      ENDIF.
    ELSE.
      client->refresh_request( EXCEPTIONS OTHERS = 1 ).
      client->refresh_response( EXCEPTIONS OTHERS = 1 ).
      IF username IS NOT INITIAL.
        client->authenticate( username = username password = CONV #( password ) ).
      ENDIF.
    ENDIF.
    client->request->set_method( 'GET' ).
    client->request->set_version( if_http_request=>co_protocol_version_1_1 ).
    cl_http_utility=>set_request_uri( request = client->request uri = parsed-path && parsed-query ).
    client->request->set_header_field( name = 'Accept' value = 'application/json;odata.metadata=minimal;IEEE754Compatible=true' ).
    client->request->set_header_field( name = 'Prefer' value = |odata.maxpagesize={ settings-page_size NUMBER = RAW }| ).
    client->request->set_header_field( name = 'Accept-Encoding' value = 'identity' ).
    DATA(remaining) = CONV i( ceil( ( CONV decfloat34( settings-scan_timeout_seconds ) * 1000000
      - ( timer->now( ) - started ) ) / 1000000 ) ).
    DATA(timeout) = nmin( val1 = settings-request_timeout_seconds val2 = remaining ).
    IF timeout < 1.
      fail( 'TIMEOUT' ).
    ENDIF.
    DATA(request_started) = timer->now( ).
    client->send( EXPORTING timeout = timeout EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc <> 0.
      deadline( ).
      IF timer->now( ) - request_started >= CONV int8( settings-request_timeout_seconds ) * 1000000.
        fail( 'TIMEOUT' ).
      ENDIF.
      client->get_last_error( IMPORTING code = DATA(error_number) message = DATA(error_text) ).
      IF error_number = 402 OR to_lower( error_text ) CS 'timeout' OR to_lower( error_text ) CS 'timed out'.
        fail( 'TIMEOUT' ).
      ENDIF.
      fail( 'TRANSPORT' ).
    ENDIF.
    client->receive( EXCEPTIONS OTHERS = 1 ).
    IF sy-subrc <> 0.
      deadline( ).
      IF timer->now( ) - request_started >= CONV int8( settings-request_timeout_seconds ) * 1000000.
        fail( 'TIMEOUT' ).
      ENDIF.
      client->get_last_error( IMPORTING code = error_number message = error_text ).
      IF error_number = 402 OR to_lower( error_text ) CS 'timeout' OR to_lower( error_text ) CS 'timed out'.
        fail( 'TIMEOUT' ).
      ENDIF.
      fail( 'TRANSPORT' ).
    ENDIF.
    client->response->get_status( IMPORTING code = page-status ).
    current_result-error-http_status = page-status.
    IF timer->now( ) - request_started >= CONV int8( settings-request_timeout_seconds ) * 1000000.
      fail( 'TIMEOUT' ).
    ENDIF.
    deadline( ).
    IF page-status <> 200.
      fail( 'HTTP_STATUS' ).
    ENDIF.
    DATA(length) = client->response->get_header_field( 'Content-Length' ).
    IF matches( val = length pcre = '^[0-9]+$' ).
      TRY.
          IF CONV int8( length ) > settings-max_body_bytes.
            fail( 'LIMIT' ).
          ENDIF.
        CATCH cx_sy_conversion_overflow.
          fail( 'LIMIT' ).
      ENDTRY.
    ENDIF.
    page-body_raw = client->response->get_data( ).
    page-url = url.
  ENDMETHOD.

  METHOD fixture.
    DATA(config) = defaults( ).
    DATA(has_root) = abap_false.
    DATA(has_count) = abap_false.
    DATA(has_digest) = abap_false.
    TRY.
        DATA(reader) = cl_json_string_reader=>create( config_json ).
        DATA(node) = reader->next_node( ).
        IF node-type <> if_json_node=>open_object.
          fail( 'CONFIG' ).
        ENDIF.
        DO.
          node = reader->next_node( ).
          IF node-type = if_json_node=>close_object.
            EXIT.
          ENDIF.
          FIELD-SYMBOLS <field> TYPE any.
          ASSIGN COMPONENT to_upper( node-name ) OF STRUCTURE config TO <field>.
          IF sy-subrc = 0.
            IF node-name = 'service_root' OR node-name = 'sap_client' OR node-name = 'expected_digest'.
              IF node-type <> if_json_node=>string.
                fail( 'CONFIG' ).
              ENDIF.
              <field> = node-value.
            ELSE.
              IF node-type <> if_json_node=>number
                OR NOT matches( val = node-value pcre = '^-?[0-9]+\z' ).
                fail( 'CONFIG' ).
              ENDIF.
              <field> = CONV i( node-value ).
            ENDIF.
            CASE node-name.
              WHEN 'service_root'. has_root = abap_true.
              WHEN 'expected_rows'. has_count = abap_true.
              WHEN 'expected_digest'. has_digest = abap_true.
            ENDCASE.
          ELSE.
            reader->skip_node( ).
          ENDIF.
        ENDDO.
        node = reader->next_node( ).
        IF node-type <> if_json_node=>final OR has_root = abap_false
          OR has_count = abap_false OR has_digest = abap_false.
          fail( 'CONFIG' ).
        ENDIF.
        result = scan( config = config pages = pages ).
      CATCH cx_root.
        result = VALUE #( schema_version = 1 outcome = 'error' error-code = 'CONFIG' ).
    ENDTRY.
  ENDMETHOD.

  METHOD scan.
    settings = config.
    CLEAR: current_result, previous_order, previous_position, client, nodes.
    current_result-schema_version = 1.
    current_result-scan_index = scan_index.
    timer = NEW lcl_bl_clock( ).
    started = timer->now( ).
    TRY.
        config_check( ).
        digest = cl_abap_message_digest=>get_instance( 'SHA-256' ).
        digest->update( cl_abap_message_digest=>string_to_xstring(
          |sap-polling-lab{ cl_abap_char_utilities=>horizontal_tab }1{ cl_abap_char_utilities=>newline }| ) ).
        DATA(url) = root-absolute && 'OrderPositions?$select=OrderId%2CPositionNumber%2CCustomerId%2COrderDate%2CMaterialId%2CQuantity%2CUnit%2CNetAmount%2CCurrency&$orderby=OrderId%2CPositionNumber&sap-client=' && settings-sap_client.
        DATA visited TYPE HASHED TABLE OF string WITH UNIQUE KEY table_line.
        INSERT url INTO TABLE visited.
        DO.
          deadline( ).
          current_result-error-page_index = current_result-pages + 1.
          CLEAR current_result-error-http_status.
          IF current_result-pages >= settings-max_pages.
            fail( 'LIMIT' ).
          ENDIF.
          current_result-pages += 1.
          DATA page TYPE ty_page.
          CLEAR page.
          IF pages IS SUPPLIED.
            READ TABLE pages INDEX current_result-pages INTO page.
            IF sy-subrc <> 0.
              fail( 'TRANSPORT' ).
            ENDIF.
            current_result-error-http_status = page-status.
            IF page-status <> 200.
              fail( 'HTTP_STATUS' ).
            ENDIF.
            IF page-body_raw IS INITIAL.
              page-body_raw = cl_abap_message_digest=>string_to_xstring( page-body_json ).
            ENDIF.
          ELSE.
            page = page_read( url = url destination = destination username = username password = password internal = internal ).
          ENDIF.
          current_result-body_bytes += xstrlen( page-body_raw ).
          IF xstrlen( page-body_raw ) > settings-max_body_bytes.
            fail( 'LIMIT' ).
          ENDIF.
          deadline( ).
          DATA(next_link) = process_page( page-body_raw ).
          deadline( ).
          IF next_link IS INITIAL.
            EXIT.
          ENDIF.
          DATA(next_url) = continuation( value = next_link current = url ).
          INSERT next_url INTO TABLE visited.
          IF sy-subrc <> 0.
            fail( 'LIMIT' ).
          ENDIF.
          url = next_url.
        ENDDO.
        IF current_result-rows <> settings-expected_rows.
          fail( 'COUNT' ).
        ENDIF.
        DATA hash TYPE string.
        digest->digest( IMPORTING ef_hashstring = hash ).
        TRANSLATE hash TO LOWER CASE.
        deadline( ).
        IF hash <> settings-expected_digest.
          fail( 'DIGEST' ).
        ENDIF.
        current_result-digest = hash.
        current_result-outcome = 'ok'.
        CLEAR current_result-error.
      CATCH lcx_bl_poll INTO DATA(error).
        current_result-outcome = 'error'.
        current_result-error-code = error->code.
        IF error->code = 'TIMEOUT' OR error->code = 'TRANSPORT'.
          CLEAR current_result-error-http_status.
        ENDIF.
      CATCH cx_root.
        current_result-outcome = 'error'.
        current_result-error-code = 'SCHEMA'.
    ENDTRY.
    IF client IS BOUND.
      client->close( EXCEPTIONS OTHERS = 1 ).
    ENDIF.
    current_result-elapsed_ms = ( timer->now( ) - started ) DIV 1000.
    result = current_result.
  ENDMETHOD.

  METHOD scan_cds.
    settings = config.
    CLEAR: current_result, previous_order, previous_position, client, nodes.
    current_result-schema_version = 1.
    current_result-scan_index = scan_index.
    timer = NEW lcl_bl_clock( ).
    started = timer->now( ).
    TRY.
        config_check( direct = abap_true ).
        digest = cl_abap_message_digest=>get_instance( 'SHA-256' ).
        digest->update( cl_abap_message_digest=>string_to_xstring(
          |sap-polling-lab{ cl_abap_char_utilities=>horizontal_tab }1{ cl_abap_char_utilities=>newline }| ) ).
        deadline( ).
        current_result-error-page_index = 1.
        " One Open SQL cursor; INTO TABLE replaces the bounded package each iteration.
        SELECT OrderId, PositionNumber, CustomerId, OrderDate, MaterialId,
          Quantity, Unit, NetAmount, Currency
          FROM ZI_BL_OrderPosition
          ORDER BY OrderId, PositionNumber
          INTO TABLE @DATA(batch) PACKAGE SIZE 100.
          current_result-error-page_index = current_result-pages + 1.
          IF current_result-pages >= settings-max_pages.
            fail( 'LIMIT' ).
          ENDIF.
          current_result-pages += 1.
          deadline( ).
          LOOP AT batch INTO DATA(row).
            deadline( ).
            DATA(values) = VALUE string_table(
              ( CONV string( row-OrderId ) )
              ( CONV string( row-PositionNumber ) )
              ( CONV string( row-CustomerId ) )
              ( |{ row-OrderDate DATE = ISO }| )
              ( CONV string( row-MaterialId ) )
              ( |{ row-Quantity NUMBER = RAW DECIMALS = 3 }| )
              ( CONV string( row-Unit ) )
              ( |{ row-NetAmount NUMBER = RAW DECIMALS = 2 }| )
              ( CONV string( row-Currency ) ) ).
            validate_values( values ).
          ENDLOOP.
          CLEAR batch.
        ENDSELECT.
        " ENDSELECT closes the cursor before final checks and before the timer ends.
        deadline( ).
        IF current_result-rows <> settings-expected_rows.
          fail( 'COUNT' ).
        ENDIF.
        DATA hash TYPE string.
        digest->digest( IMPORTING ef_hashstring = hash ).
        TRANSLATE hash TO LOWER CASE.
        deadline( ).
        IF hash <> settings-expected_digest.
          fail( 'DIGEST' ).
        ENDIF.
        current_result-digest = hash.
        current_result-outcome = 'ok'.
        CLEAR current_result-error.
      CATCH lcx_bl_poll INTO DATA(error).
        current_result-outcome = 'error'.
        current_result-error-code = error->code.
      CATCH cx_root.
        current_result-outcome = 'error'.
        current_result-error-code = 'SCHEMA'.
    ENDTRY.
    current_result-elapsed_ms = ( timer->now( ) - started ) DIV 1000.
    result = current_result.
  ENDMETHOD.

  METHOD run.
    DATA(run_timer) = NEW lcl_bl_clock( ).
    DATA(origin) = run_timer->now( ).
    DATA(previous_slot) = CONV int8( 0 ).
    DO nmax( val1 = 1 val2 = config-scans ) TIMES.
      DATA(index) = sy-index - 1.
      DATA(result) = scan( config = config destination = destination username = username
        password = password internal = internal scan_index = index ).
      DATA(fatal) = xsdbool( result-outcome = 'error' AND (
        result-error-code = 'CONFIG' OR result-error-code = 'SCHEMA'
        OR result-error-code = 'ORDER' OR result-error-code = 'NEXTLINK'
        OR result-error-code = 'LIMIT' OR result-error-code = 'COUNT' OR result-error-code = 'DIGEST'
        OR ( result-error-code = 'HTTP_STATUS' AND ( result-error-http_status = 400
          OR result-error-http_status = 401 OR result-error-http_status = 403 OR result-error-http_status = 404 ) ) ) ).
      IF result-error-code = 'CONFIG'.
        APPEND result TO results.
        EXIT.
      ENDIF.
      DATA(now) = run_timer->now( ) - origin.
      DATA(interval) = CONV int8( config-interval_ms ) * 1000.
      DATA(slot) = now DIV interval + 1.
      result-missed_slots = CONV i( nmax( val1 = 0 val2 = slot - previous_slot - 1 ) ).
      previous_slot = slot.
      APPEND result TO results.
      IF fatal = abap_true OR index + 1 >= config-scans.
        EXIT.
      ENDIF.
      DATA(wait_seconds) = CONV decfloat34( slot * interval - now ) / 1000000.
      WAIT UP TO wait_seconds SECONDS.
    ENDDO.
  ENDMETHOD.

  METHOD to_json.
    TYPES: BEGIN OF ty_metrics,
      elapsed_ms TYPE int8,
      body_bytes TYPE int8,
      missed_slots TYPE i,
    END OF ty_metrics.
    TYPES: BEGIN OF ty_json_result,
      schema_version TYPE i,
      scan_index TYPE i,
      outcome TYPE string,
      rows TYPE i,
      pages TYPE i,
      digest TYPE /ui2/cl_json=>json,
      error TYPE /ui2/cl_json=>json,
      metrics TYPE ty_metrics,
    END OF ty_json_result.
    TYPES: BEGIN OF ty_json_error,
      code TYPE string,
      page_index TYPE i,
      http_status TYPE /ui2/cl_json=>json,
    END OF ty_json_error.
    DATA(output) = VALUE ty_json_result( schema_version = 1 scan_index = result-scan_index
      outcome = result-outcome rows = result-rows pages = result-pages digest = 'null' error = 'null'
      metrics = VALUE #( elapsed_ms = result-elapsed_ms body_bytes = result-body_bytes missed_slots = result-missed_slots ) ).
    IF result-outcome = 'ok'.
      output-digest = /ui2/cl_json=>serialize( result-digest ).
    ELSE.
      DATA(error) = VALUE ty_json_error( code = result-error-code page_index = result-error-page_index http_status = 'null' ).
      IF result-error-http_status <> 0.
        error-http_status = |{ result-error-http_status NUMBER = RAW }|.
      ENDIF.
      output-error = /ui2/cl_json=>serialize( data = error pretty_name = /ui2/cl_json=>pretty_mode-low_case ).
    ENDIF.
    json = /ui2/cl_json=>serialize( data = output pretty_name = /ui2/cl_json=>pretty_mode-low_case ).
  ENDMETHOD.
  METHOD scan_native.
    TYPES: BEGIN OF ty_native_row,
      orderid TYPE string,
      positionnumber TYPE string,
      customerid TYPE string,
      orderdate TYPE string,
      materialid TYPE string,
      quantity TYPE string,
      unit TYPE string,
      netamount TYPE string,
      currency TYPE string,
    END OF ty_native_row.
    DATA batch TYPE STANDARD TABLE OF ty_native_row WITH EMPTY KEY.
    DATA cursor TYPE REF TO cl_sql_result_set.
    settings = config.
    CLEAR: current_result, previous_order, previous_position, client, nodes.
    current_result-schema_version = 1.
    current_result-scan_index = scan_index.
    timer = NEW lcl_bl_clock( ).
    started = timer->now( ).
    TRY.
        config_check( direct = abap_true ).
        IF sy-mandt <> '001'.
          fail( 'CONFIG' ).
        ENDIF.
        digest = cl_abap_message_digest=>get_instance( 'SHA-256' ).
        digest->update( cl_abap_message_digest=>string_to_xstring(
          |sap-polling-lab{ cl_abap_char_utilities=>horizontal_tab }1{ cl_abap_char_utilities=>newline }| ) ).
        deadline( ).
        DATA(statement) = NEW cl_sql_statement( ).
        cursor = statement->execute_query(
          `SELECT "ORDERID", "POSITIONNUMBER", "CUSTOMERID", "ORDERDATE", ` &&
          `"MATERIALID", "QUANTITY", "UNIT", "NETAMOUNT", "CURRENCY" ` &&
          `FROM "ZBL_BENCH_SQL"."ORDER_POSITIONS_001" ` &&
          `ORDER BY "ORDERID", "POSITIONNUMBER"` ).
        cursor->set_param_table( itab_ref = REF #( batch ) ).
        DO.
          deadline( ).
          CLEAR batch.
          current_result-error-page_index = current_result-pages + 1.
          IF current_result-pages >= settings-max_pages. fail( 'LIMIT' ). ENDIF.
          current_result-pages += 1.
          DATA(fetched) = cursor->next_package( upto = 100 ).
          deadline( ).
          LOOP AT batch INTO DATA(row).
            deadline( ).
            validate_values( VALUE string_table(
              ( row-orderid ) ( row-positionnumber ) ( row-customerid )
              ( row-orderdate ) ( row-materialid ) ( row-quantity )
              ( row-unit ) ( row-netamount ) ( row-currency ) ) ).
          ENDLOOP.
          IF fetched < 100. EXIT. ENDIF.
        ENDDO.
        cursor->close( ).
        CLEAR cursor.
        deadline( ).
        IF current_result-rows <> settings-expected_rows. fail( 'COUNT' ). ENDIF.
        DATA hash TYPE string.
        digest->digest( IMPORTING ef_hashstring = hash ).
        TRANSLATE hash TO LOWER CASE.
        deadline( ).
        IF hash <> settings-expected_digest. fail( 'DIGEST' ). ENDIF.
        current_result-digest = hash.
        current_result-outcome = 'ok'.
        CLEAR current_result-error.
      CATCH lcx_bl_poll INTO DATA(error).
        current_result-outcome = 'error'.
        current_result-error-code = error->code.
      CATCH cx_sql_exception INTO DATA(sql_error).
        current_result-outcome = 'error'.
        current_result-error-code = COND #(
          WHEN sql_error->sql_code = 613 OR timer->now( ) - started
            >= CONV int8( settings-scan_timeout_seconds ) * 1000000
          THEN 'TIMEOUT' ELSE 'TRANSPORT' ).
      CATCH cx_root.
        current_result-outcome = 'error'.
        current_result-error-code = 'SCHEMA'.
    ENDTRY.
    IF cursor IS BOUND.
      TRY.
          cursor->close( ).
        CATCH cx_sql_exception.
          " Preserve the original scan error if cursor cleanup also fails.
      ENDTRY.
    ENDIF.
    current_result-elapsed_ms = ( timer->now( ) - started ) DIV 1000.
    result = current_result.
  ENDMETHOD.
ENDCLASS.
